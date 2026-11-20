const fs = require('fs');
const path = require('path');
const axios = require('axios');
const vm = require('vm');

const CACHE_FILE = path.join(__dirname, '../data/livebench_math_cache.json');

const LIVEBENCH_BASE = 'https://raw.githubusercontent.com/LiveBench/livebench.github.io/main';

function normalizeKey(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanModelIdentifier(str) {
  return (str || '')
    .toLowerCase()
    .replace(/202[0-9]-[0-9]{2}-[0-9]{2}/g, '')
    .replace(/202[0-9]{5}/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Matches a LiveBench model entry to an existing Artificial Analysis model
 * to inherit pricing, speed, latency, context length, and provider details.
 */
function matchLiveBenchToAA(liveId, liveInfo, aaModels) {
  if (!Array.isArray(aaModels) || aaModels.length === 0) return null;

  const normLive = normalizeKey(liveId);
  const normDisplay = normalizeKey(liveInfo.displayName || '');
  const normBase = normalizeKey(liveInfo.baseName || '');

  // 1. Direct key matching
  let match = aaModels.find(m => {
    const s = normalizeKey(m.slug);
    const n = normalizeKey(m.name);
    const id = normalizeKey(m.id || m.modelId);
    return s === normLive || n === normLive || id === normLive ||
           (normDisplay && (s === normDisplay || n === normDisplay)) ||
           (normBase && (s === normBase || n === normBase));
  });
  if (match) return match;

  // 2. Date-stripped clean matching (e.g. gpt-5.2-2025-12-11-high -> gpt-5.2-high)
  const cleanLive = cleanModelIdentifier(liveId);
  match = aaModels.find(m => {
    const s = cleanModelIdentifier(m.slug);
    const n = cleanModelIdentifier(m.name);
    return s === cleanLive || n === cleanLive;
  });
  if (match) return match;

  // 3. Substring matching for frontier variants (e.g. claude-fable-5-xhigh-effort -> claude-fable-5-xhigh)
  const strippedLive = cleanLive
    .replace(/effort/g, '')
    .replace(/thinking/g, '')
    .replace(/preview/g, '')
    .replace(/latest/g, '');

  match = aaModels.find(m => {
    const s = cleanModelIdentifier(m.slug)
      .replace(/effort/g, '')
      .replace(/thinking/g, '')
      .replace(/fallback/g, '')
      .replace(/default/g, '');
    return s.length >= 6 && (strippedLive.includes(s) || s.includes(strippedLive));
  });

  return match || null;
}

/**
 * Scrapes and aggregates the official Mathematics Benchmark from LiveBench AI
 * Source: https://livebench.ai (repo: LiveBench/livebench.github.io)
 * Evaluates: AMPS_Hard, integrals_with_game, math_comp, olympiad
 */
async function scrapeLiveBenchMath(aaModels = null) {
  console.log('📐 LiveBench Math: Fetching latest benchmark data from LiveBench AI (https://livebench.ai)...');

  let csv26Data = null;
  let csv01Data = null;
  let categoriesData = null;
  let modelLinksCode = null;

  try {
    const [c26Res, c01Res, catRes, metaRes] = await Promise.all([
      axios.get(`${LIVEBENCH_BASE}/public/table_2026_06_25.csv`, { timeout: 10000 }),
      axios.get(`${LIVEBENCH_BASE}/public/table_2026_01_08.csv`, { timeout: 10000 }),
      axios.get(`${LIVEBENCH_BASE}/public/categories_2026_06_25.json`, { timeout: 10000 }),
      axios.get(`${LIVEBENCH_BASE}/src/Table/modelLinks.js`, { timeout: 10000 })
    ]);

    csv26Data = c26Res.data;
    csv01Data = c01Res.data;
    categoriesData = catRes.data;
    modelLinksCode = metaRes.data;
  } catch (netErr) {
    console.warn('⚠️ Network fetch error for LiveBench:', netErr.message);
    if (fs.existsSync(CACHE_FILE)) {
      console.log('📁 Loading LiveBench Math data from local cache...');
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        return cached;
      } catch (e) {
        console.error('Error reading LiveBench cache:', e.message);
      }
    }
    throw netErr;
  }

  // Parse modelLinks.js in sandbox
  let getModelInfo = (name) => ({ displayName: name, organization: 'AI' });
  try {
    const code = modelLinksCode.replace(/export\s+const\s+/g, 'const ') + '; module.exports = { modelLinks, getModelInfo };';
    const context = { module: {} };
    vm.runInNewContext(code, context);
    if (typeof context.module.exports?.getModelInfo === 'function') {
      getModelInfo = context.module.exports.getModelInfo;
    }
  } catch (err) {
    console.warn('⚠️ Error evaluating modelLinks.js:', err.message);
  }

  // Mathematics benchmark subcategories
  const mathCols = categoriesData?.Mathematics || ['AMPS_Hard', 'integrals_with_game', 'math_comp', 'olympiad'];

  function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const map = new Map();

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map(c => c.trim());
      const model = row[0];
      const scores = {};
      const validScores = [];

      for (const colName of mathCols) {
        const idx = headers.indexOf(colName);
        if (idx !== -1) {
          const val = parseFloat(row[idx]);
          if (!isNaN(val)) {
            scores[colName] = Math.round(val * 10) / 10;
            validScores.push(val);
          }
        }
      }

      if (validScores.length > 0) {
        const rawAvg = validScores.reduce((a, b) => a + b, 0) / validScores.length;
        map.set(model, {
          rawId: model,
          mathScore: Math.round(rawAvg * 10) / 10,
          unrounded: rawAvg,
          breakdown: scores
        });
      }
    }
    return map;
  }

  const map01 = parseCSV(csv01Data);
  const map26 = parseCSV(csv26Data);

  // Combine: latest 2026-06-25 release overrides 2026-01-08 for same model
  const combined = new Map(map01);
  for (const [k, v] of map26) {
    combined.set(k, { ...v, release: '2026-06-25' });
  }

  // Load AA models if not provided
  let aaList = aaModels;
  if (!aaList || !Array.isArray(aaList) || aaList.length === 0) {
    const rawDataPath = path.join(__dirname, '../data/raw_data.json');
    if (fs.existsSync(rawDataPath)) {
      try {
        const rawJson = JSON.parse(fs.readFileSync(rawDataPath, 'utf8'));
        aaList = rawJson?.sources?.llms?.data || [];
      } catch (_) {}
    }
  }

  const resultModels = [];

  for (const [modelId, liveEntry] of combined) {
    const info = getModelInfo(modelId) || {};
    const aaMatch = matchLiveBenchToAA(modelId, info, aaList);

    const displayName = info.displayName || aaMatch?.name || modelId;
    const organization = info.organization || aaMatch?.creator?.name || aaMatch?.organization || 'AI';
    const orgSlug = organization.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ai';
    const modelSlug = (aaMatch?.slug || modelId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const canonicalModelId = `${orgSlug}/${modelSlug}`;

    // Pricing & speeds from AA match
    const pricing = aaMatch?.pricing || {
      price_1m_input_tokens: aaMatch?.price1mInputTokens ?? null,
      price_1m_output_tokens: aaMatch?.price1mOutputTokens ?? null
    };

    const speed = aaMatch?.median_output_tokens_per_second ?? (aaMatch?.headline?.outputSpeed ? parseFloat(aaMatch.headline.outputSpeed) : null);
    const latency = aaMatch?.median_time_to_first_token_seconds ?? (aaMatch?.headline?.timeToFirstAnswerToken ? parseFloat(aaMatch.headline.timeToFirstAnswerToken) : null);
    const contextLength = aaMatch?.context_length ?? aaMatch?.contextWindowTokens ?? null;

    resultModels.push({
      id: modelSlug,
      slug: modelSlug,
      modelId: canonicalModelId,
      name: displayName,
      organization: organization,
      model_creator: {
        name: organization,
        slug: orgSlug
      },
      rating: aaMatch?.rating || aaMatch?.arena_elo || Math.round(1000 + liveEntry.mathScore * 5.5),
      arena_elo: aaMatch?.arena_elo || null,
      final_score: liveEntry.mathScore,
      confidence: 95,
      coverage: 100,
      ranking_status: 'verified_livebench_ai_math',
      data_sources: ['livebench_ai'],
      category_scores: {
        math: liveEntry.mathScore,
        ...(aaMatch?.category_scores || {})
      },
      evaluations: {
        livebench_math: liveEntry.mathScore,
        livebench_amps_hard: liveEntry.breakdown['AMPS_Hard'] ?? null,
        livebench_integrals: liveEntry.breakdown['integrals_with_game'] ?? null,
        livebench_math_comp: liveEntry.breakdown['math_comp'] ?? null,
        livebench_olympiad: liveEntry.breakdown['olympiad'] ?? null,
        artificial_analysis_math_index: liveEntry.mathScore,
        ...(aaMatch?.evaluations || {})
      },
      pricing: pricing,
      median_output_tokens_per_second: speed,
      median_time_to_first_token_seconds: latency,
      context_length: contextLength,
      isDefault: false,
      isRouter: false,
      isCodingAgent: false,
      deprecated: false,
      unroundedAverage: liveEntry.unrounded,
      livebench_raw_id: modelId,
      livebench_release: liveEntry.release || '2026-01-08'
    });
  }

  // Sort descending by LiveBench math score, then unrounded score
  resultModels.sort((a, b) => {
    if (b.final_score !== a.final_score) {
      return b.final_score - a.final_score;
    }
    return (b.unroundedAverage || 0) - (a.unroundedAverage || 0);
  });

  // Assign 1-based ranks
  resultModels.forEach((m, idx) => {
    m.rank = idx + 1;
  });

  // Cache to disk
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(resultModels, null, 2), 'utf8');
    console.log(`💾 LiveBench Math: Successfully cached ${resultModels.length} models to ${CACHE_FILE}`);
  } catch (err) {
    console.warn('⚠️ Could not write LiveBench cache:', err.message);
  }

  console.log(`🎉 LiveBench Math: Successfully scraped and ranked ${resultModels.length} models! #1: ${resultModels[0].name} (${resultModels[0].final_score})`);
  return resultModels;
}

module.exports = { scrapeLiveBenchMath };
