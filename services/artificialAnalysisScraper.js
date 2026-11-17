const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const { webcrypto } = require('node:crypto');
const crypto = webcrypto || globalThis.crypto;

/**
 * Decrypts an encrypted Artificial Analysis manifest payload using AES-256-GCM + GZIP.
 * @param {{ path: string, key: string }} manifestObj 
 * @returns {Promise<Array<Object>>}
 */
async function decryptManifest(manifestObj) {
  const { path: relPath, key: hexKey } = manifestObj;
  const fullUrl = 'https://artificialanalysis.ai' + relPath;
  console.log(`📡 Fetching encrypted manifest binary from ${fullUrl}...`);

  const res = await axios.get(fullUrl, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 15000
  });

  const arrayBuffer = res.data;

  // Convert hex key to Uint8Array
  const keyBytes = new Uint8Array(hexKey.length / 2);
  for (let i = 0; i < hexKey.length; i += 2) {
    keyBytes[i / 2] = parseInt(hexKey.slice(i, i + 2), 16);
  }

  // IV is SHA-256 hash of key, sliced to 12 bytes
  const sha256Hash = await crypto.subtle.digest('SHA-256', keyBytes.buffer);
  const iv = new Uint8Array(sha256Hash).slice(0, 12);

  // Import key for AES-GCM
  const importedKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt AES-GCM
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer, tagLength: 128 },
    importedKey,
    arrayBuffer
  );

  // GZIP Decompression via zlib.gunzipSync
  const decompressed = zlib.gunzipSync(Buffer.from(decryptedBuffer));
  const parsedData = JSON.parse(decompressed.toString('utf8'));

  if (Array.isArray(parsedData)) {
    return parsedData;
  } else if (parsedData && Array.isArray(parsedData.models)) {
    return parsedData.models;
  }
  return parsedData;
}

/**
 * Scrapes Coding Agent Index data from https://artificialanalysis.ai/agents/coding-agents
 * Incorporates 3 benchmarks: FrontierCode-AA 2.0, SWE-Atlas-QnA-AA, Terminal-Bench 4.1
 * @returns {Promise<Array<Object>>} Array of detailed agent objects
 */
async function scrapeCodingAgentsData() {
  const agentsList = [];
  const cachePath = path.join(__dirname, '../data/coding_agents_cache.json');
  const streamFallbackPath = path.join(__dirname, '../scratch/full_coding_stream.txt');

  try {
    const url = 'https://artificialanalysis.ai/agents/coding-agents';
    console.log(`🌐 Scraping Coding Agents Leaderboard from ${url}...`);
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });

    const html = res.data;
    const chunks = [];
    const sandbox = {
      self: {
        __next_f: {
          push: (arr) => {
            if (arr && arr.length > 1) {
              chunks.push(arr[1]);
            }
          }
        }
      }
    };

    const scriptRegex = /<script>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const code = match[1];
      if (code.includes('self.__next_f.push')) {
        try {
          vm.runInNewContext(code, sandbox);
        } catch (_) {}
      }
    }

    const content = chunks.join('');
    if (content.length > 0) {
      const agentObjects = [];
      let searchPos = 0;

      while (true) {
        const idPos = content.indexOf('{"id":"', searchPos);
        if (idPos === -1) break;

        const sample = content.substring(idPos, idPos + 100);
        if (sample.includes('"agentName"') || sample.includes('"agentSlug"') || sample.includes('"isDefault"')) {
          let depth = 0;
          let inString = false;
          let escape = false;
          let endObj = -1;
          for (let i = idPos; i < content.length; i++) {
            const c = content[i];
            if (escape) {
              escape = false;
              continue;
            }
            if (c === '\\') {
              escape = true;
              continue;
            }
            if (c === '"') {
              inString = !inString;
              continue;
            }
            if (!inString) {
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) {
                  endObj = i + 1;
                  break;
                }
              }
            }
          }

          if (endObj !== -1) {
            try {
              const objStr = content.substring(idPos, endObj);
              const agent = JSON.parse(objStr);
              agentObjects.push(agent);
              searchPos = endObj;
              continue;
            } catch (_) {}
          }
        }
        searchPos = idPos + 7;
      }

      // Deduplicate by id
      const byId = new Map();
      for (const a of agentObjects) {
        if (a.id) byId.set(a.id, a);
      }

      for (const r of byId.values()) {
        const rewards = (r.evals || []).map(e => e.mean?.reward).filter(x => typeof x === 'number');
        const unroundedAverage = rewards.length ? (rewards.reduce((s, v) => s + v, 0) / rewards.length) : 0;
        const score = Math.round(unroundedAverage * 100);

        let creatorName = r.modelCreators?.[0]?.name || r.agentCreator?.name || 'Independent';
        let creatorSlug = r.modelCreators?.[0]?.slug || r.agentCreator?.slug || 'independent';
        const labelLower = (r.shortLabel || '').toLowerCase();
        if (labelLower.includes('claude') || labelLower.includes('anthropic')) {
          creatorName = 'Anthropic';
          creatorSlug = 'anthropic';
        } else if (labelLower.includes('gemini') || labelLower.includes('antigravity')) {
          creatorName = 'Google';
          creatorSlug = 'google';
        } else if (labelLower.includes('muse')) {
          creatorName = 'Meta';
          creatorSlug = 'meta';
        } else if (labelLower.includes('gpt') || labelLower.includes('codex')) {
          creatorName = 'OpenAI';
          creatorSlug = 'openai';
        } else if (labelLower.includes('kimi')) {
          creatorName = 'Moonshot AI';
          creatorSlug = 'moonshot';
        } else if (labelLower.includes('grok')) {
          creatorName = 'xAI';
          creatorSlug = 'xai';
        } else if (labelLower.includes('mistral')) {
          creatorName = 'Mistral AI';
          creatorSlug = 'mistralai';
        } else if (labelLower.includes('glm') || labelLower.includes('opencode')) {
          creatorName = 'Zhipu AI';
          creatorSlug = 'zhipu';
        } else if (labelLower.includes('deepseek')) {
          creatorName = 'DeepSeek';
          creatorSlug = 'deepseek';
        }

        const modelName = r.model?.name || r.display?.model || r.shortLabel;
        const cleanSlug = (r.shortLabel || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        agentsList.push({
          id: cleanSlug,
          agentId: r.id,
          slug: cleanSlug,
          shortLabel: r.shortLabel,
          label: r.shortLabel,
          displayLabel: r.displayLabel,
          agentName: r.agentName,
          modelName: modelName,
          creatorName: creatorName,
          creatorSlug: creatorSlug,
          isDefault: !!r.isDefault,
          isRouter: !!r.isRouter,
          isHighlighted: !!r.isHighlighted,
          score: score,
          unroundedAverage: unroundedAverage,
          rewards: rewards,
          evals: r.evals
        });
      }

      console.log(`✅ Extracted ${agentsList.length} official Coding Agent Index models from live site.`);
      try {
        fs.writeFileSync(cachePath, JSON.stringify(agentsList, null, 2), 'utf8');
      } catch (_) {}
    }
  } catch (err) {
    console.warn('⚠️ Coding agents live scraping warning:', err.message);
  }

  // Fallback to cache if live fetch failed
  if (agentsList.length === 0) {
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (Array.isArray(cached) && cached.length > 0) {
          console.log(`📂 Loaded ${cached.length} coding agents from persistent cache.`);
          return cached;
        }
      } catch (_) {}
    }

    if (fs.existsSync(streamFallbackPath)) {
      try {
        const content = fs.readFileSync(streamFallbackPath, 'utf8');
        const agentObjects = [];
        let searchPos = 0;
        while (true) {
          const idPos = content.indexOf('{"id":"', searchPos);
          if (idPos === -1) break;
          const sample = content.substring(idPos, idPos + 100);
          if (sample.includes('"agentName"') || sample.includes('"agentSlug"') || sample.includes('"isDefault"')) {
            let depth = 0;
            let inString = false;
            let escape = false;
            let endObj = -1;
            for (let i = idPos; i < content.length; i++) {
              const c = content[i];
              if (escape) { escape = false; continue; }
              if (c === '\\') { escape = true; continue; }
              if (c === '"') { inString = !inString; continue; }
              if (!inString) {
                if (c === '{') depth++;
                else if (c === '}') {
                  depth--;
                  if (depth === 0) { endObj = i + 1; break; }
                }
              }
            }
            if (endObj !== -1) {
              try {
                const agent = JSON.parse(content.substring(idPos, endObj));
                agentObjects.push(agent);
                searchPos = endObj;
                continue;
              } catch (_) {}
            }
          }
          searchPos = idPos + 7;
        }

        const byId = new Map();
        for (const a of agentObjects) {
          if (a.id) byId.set(a.id, a);
        }

        for (const r of byId.values()) {
          const rewards = (r.evals || []).map(e => e.mean?.reward).filter(x => typeof x === 'number');
          const unroundedAverage = rewards.length ? (rewards.reduce((s, v) => s + v, 0) / rewards.length) : 0;
          const score = Math.round(unroundedAverage * 100);

          let creatorName = r.modelCreators?.[0]?.name || r.agentCreator?.name || 'Independent';
          let creatorSlug = r.modelCreators?.[0]?.slug || r.agentCreator?.slug || 'independent';
          const labelLower = (r.shortLabel || '').toLowerCase();
          if (labelLower.includes('claude') || labelLower.includes('anthropic')) {
            creatorName = 'Anthropic';
            creatorSlug = 'anthropic';
          } else if (labelLower.includes('gemini') || labelLower.includes('antigravity')) {
            creatorName = 'Google';
            creatorSlug = 'google';
          } else if (labelLower.includes('muse')) {
            creatorName = 'Meta';
            creatorSlug = 'meta';
          } else if (labelLower.includes('gpt') || labelLower.includes('codex')) {
            creatorName = 'OpenAI';
            creatorSlug = 'openai';
          } else if (labelLower.includes('kimi')) {
            creatorName = 'Moonshot AI';
            creatorSlug = 'moonshot';
          } else if (labelLower.includes('grok')) {
            creatorName = 'xAI';
            creatorSlug = 'xai';
          } else if (labelLower.includes('mistral')) {
            creatorName = 'Mistral AI';
            creatorSlug = 'mistralai';
          } else if (labelLower.includes('glm') || labelLower.includes('opencode')) {
            creatorName = 'Zhipu AI';
            creatorSlug = 'zhipu';
          } else if (labelLower.includes('deepseek')) {
            creatorName = 'DeepSeek';
            creatorSlug = 'deepseek';
          }

          const modelName = r.model?.name || r.display?.model || r.shortLabel;
          const cleanSlug = (r.shortLabel || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          agentsList.push({
            id: cleanSlug,
            agentId: r.id,
            slug: cleanSlug,
            shortLabel: r.shortLabel,
            label: r.shortLabel,
            displayLabel: r.displayLabel,
            agentName: r.agentName,
            modelName: modelName,
            creatorName: creatorName,
            creatorSlug: creatorSlug,
            isDefault: !!r.isDefault,
            isRouter: !!r.isRouter,
            isHighlighted: !!r.isHighlighted,
            score: score,
            unroundedAverage: unroundedAverage,
            rewards: rewards,
            evals: r.evals
          });
        }
        console.log(`📂 Loaded ${agentsList.length} coding agents from fallback stream.`);
      } catch (_) {}
    }
  }

  return agentsList;
}

/**
 * Scrapes all model data directly from the Artificial Analysis website.
 * @returns {Promise<Array<Object>>} List of normalized model objects from Artificial Analysis
 */
async function scrapeArtificialAnalysis() {
  console.log('🌐 Artificial Analysis Scraper: Scraping live model data from artificialanalysis.ai...');

  let mainModels = [];
  const codingAgents = await scrapeCodingAgentsData();

  try {
    const targetUrl = 'https://artificialanalysis.ai/models';
    const res = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });

    const html = res.data;

    // Collect Flight stream script chunks
    const chunks = [];
    const sandbox = {
      self: {
        __next_f: {
          push: (arr) => {
            if (arr && arr.length > 1) {
              chunks.push(arr[1]);
            }
          }
        }
      }
    };

    const scriptRegex = /<script>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const code = match[1];
      if (code.includes('self.__next_f.push')) {
        try {
          vm.runInNewContext(code, sandbox);
        } catch (_) {}
      }
    }

    const fullStream = chunks.join('');

    // Search for manifest configuration with path ending in .txt
    const manifestRegex = /"manifest"\s*:\s*\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"key"\s*:\s*"([^"]+)"\s*\}/g;
    let manifestMatch;
    let mainManifest = null;

    while ((manifestMatch = manifestRegex.exec(fullStream)) !== null) {
      const pathVal = manifestMatch[1];
      const keyVal = manifestMatch[2];
      if (pathVal.startsWith('/data/')) {
        mainManifest = { path: pathVal, key: keyVal };
      }
    }

    if (mainManifest) {
      console.log(`🔑 Found live manifest path: ${mainManifest.path}`);
      mainModels = await decryptManifest(mainManifest);
    }
  } catch (err) {
    console.error('⚠️ Live web scraping warning:', err.message);
  }

  // Fallback if live models empty
  if (!Array.isArray(mainModels) || mainModels.length === 0) {
    console.log('🔄 Scraper Fallback: Loading cached Artificial Analysis dataset...');
    const fallbackPaths = [
      path.join(__dirname, '../scratch/decrypted_main_models.json'),
      path.join(__dirname, '../data/raw_data.json')
    ];

    for (const fallbackPath of fallbackPaths) {
      if (fs.existsSync(fallbackPath)) {
        try {
          const content = await fs.promises.readFile(fallbackPath, 'utf8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) mainModels = parsed;
          else if (parsed?.sources?.llms?.data) mainModels = parsed.sources.llms.data;
          if (mainModels.length > 0) break;
        } catch (_) {}
      }
    }
  }

  // Attach codingAgentsIndex to base models AND inject dedicated coding agent models
  if (Array.isArray(mainModels) && codingAgents.length > 0) {
    const existingSlugs = new Set(mainModels.map(m => m.slug));
    const agentModelsToInject = [];

    for (const agent of codingAgents) {
      const cleanLabel = (agent.label || agent.shortLabel || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      const agentWords = cleanLabel.split(' ').filter(w => w.length > 2 && !['code', 'claude', 'codex', 'cli', 'opencode', 'cursor', 'build', 'vibe', 'harness'].includes(w));

      let bestMatch = null;
      let maxScore = 0;

      for (const m of mainModels) {
        const mName = (m.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        const mSlug = (m.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

        let matches = 0;
        for (const w of agentWords) {
          if (mName.includes(w) || mSlug.includes(w)) {
            matches++;
          }
        }

        if (matches > maxScore) {
          maxScore = matches;
          bestMatch = m;
        }
      }

      if (bestMatch && maxScore >= 1) {
        bestMatch.codingAgentsIndex = agent.score;
        bestMatch.codingIndex = agent.score;
      }

      // Create dedicated coding agent model entry matching the official Artificial Analysis Leaderboard
      const agentSlug = agent.slug || (agent.shortLabel || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!existingSlugs.has(agentSlug)) {
        const inCost = bestMatch ? parseFloat(bestMatch.price1mInputTokens ?? bestMatch.pricing?.price_1m_input_tokens ?? 0) : 0;
        const outCost = bestMatch ? parseFloat(bestMatch.price1mOutputTokens ?? bestMatch.pricing?.price_1m_output_tokens ?? 0) : 0;

        agentModelsToInject.push({
          id: agentSlug,
          slug: agentSlug,
          modelId: `${agent.creatorSlug}/${agentSlug}`,
          name: agent.shortLabel,
          shortLabel: agent.shortLabel,
          agentName: agent.agentName,
          modelName: agent.modelName,
          organization: agent.creatorName,
          creator: { name: agent.creatorName, slug: agent.creatorSlug },
          model_creator: { name: agent.creatorName, slug: agent.creatorSlug },
          rating: bestMatch?.rating || bestMatch?.arena_elo || Math.round(1000 + agent.score * 7),
          arena_elo: bestMatch?.rating || bestMatch?.arena_elo || Math.round(1000 + agent.score * 7),
          codingAgentsIndex: agent.score,
          codingIndex: agent.score,
          unroundedAverage: agent.unroundedAverage,
          isDefault: agent.isDefault,
          isRouter: agent.isRouter,
          isHighlighted: agent.isHighlighted,
          isCodingAgent: true,
          evaluations: {
            artificial_analysis_coding_index: agent.score,
            coding_agent_index: agent.score,
            frontier_code_20: agent.rewards?.[0] ? Math.round(agent.rewards[0] * 1000) / 10 : null,
            swe_atlas_qna: agent.rewards?.[1] ? Math.round(agent.rewards[1] * 1000) / 10 : null,
            terminal_bench_41: agent.rewards?.[2] ? Math.round(agent.rewards[2] * 1000) / 10 : null
          },
          pricing: { price_1m_input_tokens: inCost, price_1m_output_tokens: outCost },
          price1mInputTokens: inCost,
          price1mOutputTokens: outCost,
          contextWindowTokens: bestMatch?.contextWindowTokens || bestMatch?.context_length || 200000,
          medianOutputSpeed: bestMatch?.medianOutputSpeed || null,
          medianTimeToFirstChunk: bestMatch?.medianTimeToFirstChunk || null
        });
        existingSlugs.add(agentSlug);
      }
    }

    if (agentModelsToInject.length > 0) {
      console.log(`🤖 Injected ${agentModelsToInject.length} dedicated official Coding Agent models into model catalog.`);
      mainModels.push(...agentModelsToInject);
    }
  }

  if (Array.isArray(mainModels) && mainModels.length > 0) {
    console.log(`✅ Artificial Analysis Scraper: Successfully prepared ${mainModels.length} models.`);
    return mainModels;
  }

  throw new Error('Failed to scrape live Artificial Analysis data and no valid local cache was found.');
}

module.exports = { scrapeArtificialAnalysis, scrapeCodingAgentsData, decryptManifest };
