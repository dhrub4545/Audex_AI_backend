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
 * @returns {Promise<Array<{ label: string, score: number }>>} Array of agent objects
 */
async function scrapeCodingAgentsData() {
  const agentsList = [];
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
    const idx = html.indexOf('"codingAgentsIndex":');
    if (idx !== -1) {
      const startArr = html.lastIndexOf('[', idx);
      let braceCount = 0;
      let endArr = -1;
      for (let i = startArr; i < html.length; i++) {
        if (html[i] === '[') braceCount++;
        else if (html[i] === ']') {
          braceCount--;
          if (braceCount === 0) { endArr = i + 1; break; }
        }
      }
      if (endArr !== -1) {
        const jsonText = html.substring(startArr, endArr);
        const parsed = JSON.parse(jsonText);
        for (const item of parsed) {
          if (item.codingAgentsIndex !== undefined && item.codingAgentsIndex !== null) {
            const score = Math.round(item.codingAgentsIndex * 1000) / 10;
            agentsList.push({ label: item.label || item.name || '', score });
          }
        }
        console.log(`✅ Extracted ${agentsList.length} official Coding Agent Index scores.`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Coding agents scraping warning:', err.message);
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
          const content = fs.readFileSync(fallbackPath, 'utf8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) mainModels = parsed;
          else if (parsed?.sources?.llms?.data) mainModels = parsed.sources.llms.data;
          if (mainModels.length > 0) break;
        } catch (_) {}
      }
    }
  }

  // Robust word-intersection matching to attach codingAgentsIndex to main models
  if (Array.isArray(mainModels) && codingAgents.length > 0) {
    for (const agent of codingAgents) {
      const cleanLabel = agent.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      const agentWords = cleanLabel.split(' ').filter(w => w.length > 2 && !['code', 'claude', 'codex', 'cli', 'opencode', 'cursor'].includes(w));

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
        console.log(`🔗 Attached Coding Agent Index (${agent.score}) to model "${bestMatch.name}" (${bestMatch.slug})`);
      }
    }
  }

  if (Array.isArray(mainModels) && mainModels.length > 0) {
    console.log(`✅ Artificial Analysis Scraper: Successfully prepared ${mainModels.length} models.`);
    return mainModels;
  }

  throw new Error('Failed to scrape live Artificial Analysis data and no valid local cache was found.');
}

module.exports = { scrapeArtificialAnalysis, decryptManifest };
