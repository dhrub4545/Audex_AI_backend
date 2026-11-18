const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Model = require('../models/Model');
const { saveRawData, getRankCategory } = require('./rankStorage');
const { ALL_30_CATEGORIES, normalizeModelId, normalizeCreatorSlug } = require('../audex-ai/algorithms/overall_score');

async function syncArtificialAnalysis(scrapedModels = null) {
  console.log('🔄 Local Data Sync: Synchronizing Artificial Analysis models & updating raw_data.json...');

  // If scrapedModels is not passed, attempt to fetch live from Artificial Analysis scraper
  if (!scrapedModels || !Array.isArray(scrapedModels) || scrapedModels.length === 0) {
    try {
      const { scrapeArtificialAnalysis } = require('./artificialAnalysisScraper');
      console.log('🌐 Artificial Analysis Sync: Fetching new models list from Artificial Analysis scraper...');
      scrapedModels = await scrapeArtificialAnalysis();
    } catch (err) {
      console.warn('⚠️ Artificial Analysis Sync: Could not fetch from scraper, falling back to local files:', err.message);
    }
  }

  const modelsMap = new Map();
  const categories = {};

  // Load and merge models from all rank categories in backend/data/rank
  const rankDir = path.join(__dirname, '../data/rank');
  let categoryFiles = [];
  try {
    if (fs.existsSync(rankDir)) {
      categoryFiles = fs.readdirSync(rankDir).filter(f => f.endsWith('.json'));
    }
  } catch (_) {}

  const categoryNamesToLoad = new Set([
    ...ALL_30_CATEGORIES,
    ...categoryFiles.map(f => f.replace('.json', ''))
  ]);

  for (const categoryName of categoryNamesToLoad) {
    try {
      const data = await getRankCategory(categoryName);
      if (Array.isArray(data) && data.length > 0) {
        categories[categoryName] = data.map(item => {
          const creatorName = item.organization || item.model_creator?.name || 'Independent';
          const creatorSlug = normalizeCreatorSlug(creatorName, item.model_creator?.slug);
          const modelId = item.modelId || normalizeModelId(creatorSlug, item.slug);
          return {
            ...item,
            rank: item.rank || null,
            slug: item.slug,
            modelId: modelId,
            name: item.name || item.model_name || item.slug,
            organization: creatorName,
            rating: item.rating || item.arena_elo || null
          };
        }).sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity));

        for (const model of data) {
          if (model.id || model.slug) {
            const key = model.id || model.slug;
            if (!modelsMap.has(key)) {
              modelsMap.set(key, { ...model });
            } else {
              const existing = modelsMap.get(key);
              existing.evaluations = { ...existing.evaluations, ...model.evaluations };
              if (model.pricing) {
                existing.pricing = { ...existing.pricing, ...model.pricing };
              }
              for (const field of ['median_output_tokens_per_second', 'median_time_to_first_token_seconds', 'context_length']) {
                if (model[field] !== undefined && model[field] !== null && model[field] !== 0) {
                  existing[field] = model[field];
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`⚠️ Error loading rank data for [${categoryName}]:`, err.message);
    }
  }

  const llmModels = Array.from(modelsMap.values());
  const rawSource = (scrapedModels && Array.isArray(scrapedModels) && scrapedModels.length > 0)
    ? scrapedModels
    : llmModels;
  const sourceModels = rawSource;
  console.log(`📥 Processing every model (${sourceModels.length} total) from Artificial Analysis for database synchronization...`);

  const syncedModels = [];
  const seenModelIds = new Set();

  for (const item of sourceModels) {
    if (!item.slug && !item.name) continue;

    const creatorName = item.creator?.name || item.model_creator?.name || item.organization || 'Independent';
    const creatorSlug = normalizeCreatorSlug(creatorName, item.creator?.slug || item.model_creator?.slug);
    const slug = item.slug || (item.name ? item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown');
    const modelId = item.modelId || normalizeModelId(creatorSlug, slug);

    if (seenModelIds.has(modelId)) continue;
    seenModelIds.add(modelId);

    // Look up any matching ranked info from rank files
    const rankedInfo = modelsMap.get(item.id) || modelsMap.get(item.slug) || modelsMap.get(modelId);

    const inputCostPerM = parseFloat(item.price1mInputTokens ?? item.pricing?.price_1m_input_tokens ?? 0);
    const outputCostPerM = parseFloat(item.price1mOutputTokens ?? item.pricing?.price_1m_output_tokens ?? 0);

    const endpointData = {
      provider_name: 'Artificial Analysis',
      input_cost_per_m: isNaN(inputCostPerM) ? 0 : inputCostPerM,
      output_cost_per_m: isNaN(outputCostPerM) ? 0 : outputCostPerM,
      cache_read_cost_per_m: parseFloat(item.cacheHitPrice) || 0,
      is_active: true,
      last_synced_at: new Date()
    };

    // 100% actual benchmark metrics - Index v5
    // 1. Intelligence / Overall index (Strictly Official Intelligence Index)
    let aa_index_score = null;
    const rawIntel = parseFloat(item.intelligenceIndex ?? item.evaluations?.artificial_analysis_intelligence_index ?? item.category_scores?.overall ?? rankedInfo?.category_scores?.overall);
    if (!isNaN(rawIntel) && rawIntel > 0) {
      aa_index_score = Math.min(100, Math.round(rawIntel));
    }

    // 2. Coding index v5 (FrontierCode 2.0: 60% + Terminal-Bench 4.0: 40%)
    let coding_score = null;
    const rawFc = typeof item.frontierCode20 === 'number' ? item.frontierCode20 : (typeof item.frontierCode === 'number' ? item.frontierCode : null);
    const rawTb = typeof item.terminalBench40 === 'number' ? item.terminalBench40 : (typeof item.terminalBench21 === 'number' ? item.terminalBench21 : (typeof item.terminalbenchHard === 'number' ? item.terminalbenchHard : null));
    const rawAgents = typeof item.codingAgentsIndex === 'number' ? item.codingAgentsIndex : (typeof item.evaluations?.coding_agent_index === 'number' ? item.evaluations.coding_agent_index : null);

    if (rawFc !== null && rawTb !== null) {
      const fcNorm = rawFc <= 1 ? rawFc * 100 : rawFc;
      const tbNorm = rawTb <= 1 ? rawTb * 100 : rawTb;
      coding_score = Math.min(100, Math.round(fcNorm * 0.6 + tbNorm * 0.4));
    } else if (rawFc !== null) {
      const fcNorm = rawFc <= 1 ? rawFc * 100 : rawFc;
      coding_score = Math.min(100, Math.round(fcNorm));
    } else if (rawTb !== null) {
      const tbNorm = rawTb <= 1 ? rawTb * 100 : rawTb;
      coding_score = Math.min(100, Math.round(tbNorm));
    } else if (rawAgents !== null) {
      coding_score = Math.min(100, Math.round(rawAgents));
    } else if (rankedInfo?.category_scores?.coding) {
      coding_score = Math.min(100, Math.round(rankedInfo.category_scores.coding));
    }

    // 3. Math index (AIME 2025, SciCode)
    let math_score = null;
    const rawAime = parseFloat(item.evaluations?.aime ?? item.aime25 ?? rankedInfo?.evaluations?.aime);
    const rawMath = parseFloat(item.evaluations?.artificial_analysis_math_index ?? item.category_scores?.math ?? item.mathIndex ?? rankedInfo?.category_scores?.math);
    const rawSci = parseFloat(item.evaluations?.scicode ?? item.scicode ?? rankedInfo?.evaluations?.scicode);
    if (!isNaN(rawAime) && rawAime > 0) {
      math_score = Math.min(100, Math.round(rawAime <= 1 ? rawAime * 100 : rawAime));
    } else if (!isNaN(rawMath) && rawMath > 0) {
      math_score = Math.min(100, Math.round(rawMath));
    } else if (!isNaN(rawSci) && rawSci > 0) {
      math_score = Math.min(100, Math.round(rawSci <= 1 ? rawSci * 100 : rawSci));
    }

    // 4. Reasoning index (v5: HLE-Diamond, GPQA Diamond, HLE)
    let reasoning_score = null;
    const rawHleDiamond = parseFloat(item.hleDiamond ?? rankedInfo?.evaluations?.hle_diamond);
    const rawGpqa = parseFloat(item.evaluations?.gpqa ?? item.gpqa ?? rankedInfo?.evaluations?.gpqa);
    const rawHle = parseFloat(item.evaluations?.hle ?? item.hle ?? rankedInfo?.evaluations?.hle);
    if (!isNaN(rawHleDiamond) && rawHleDiamond > 0) {
      reasoning_score = Math.min(100, Math.round(rawHleDiamond <= 1 ? rawHleDiamond * 100 : rawHleDiamond));
    } else if (!isNaN(rawGpqa) && rawGpqa > 0) {
      reasoning_score = Math.min(100, Math.round(rawGpqa <= 1 ? rawGpqa * 100 : rawGpqa));
    } else if (!isNaN(rawHle) && rawHle > 0) {
      reasoning_score = Math.min(100, Math.round(rawHle <= 1 ? rawHle * 100 : rawHle));
    } else if (aa_index_score !== null) {
      reasoning_score = aa_index_score;
    }

    let tokens_per_second = null;
    const rawTps = item.headline?.outputSpeed || item.performanceByPromptType?.medium?.medianOutputSpeed || item.timescaleData?.medianOutputSpeed || item.medianOutputSpeed || item.median_output_tokens_per_second || rankedInfo?.median_output_tokens_per_second;
    if (rawTps !== null && rawTps !== undefined) {
      const val = parseFloat(rawTps);
      if (!isNaN(val) && val > 0) {
        tokens_per_second = Math.round(val);
      }
    }

    let time_to_first_token_ms = null;
    const rawTtft = item.headline?.timeToFirstAnswerToken || item.headline?.timeToFirstToken || item.performanceByPromptType?.medium?.medianTimeToFirstAnswerToken || item.performanceByPromptType?.medium?.medianTimeToFirstChunk || item.timescaleData?.medianTimeToFirstChunk || item.medianTimeToFirstAnswerToken || item.median_time_to_first_token_seconds || rankedInfo?.median_time_to_first_token_seconds;
    if (rawTtft !== null && rawTtft !== undefined) {
      const val = parseFloat(rawTtft);
      if (!isNaN(val) && val > 0) {
        time_to_first_token_ms = Math.round(val < 100 ? val * 1000 : val);
      }
    }

    const caps = {
      aa_index_score: aa_index_score,
      coding_score: coding_score,
      math_score: math_score,
      reasoning_score: reasoning_score,
      tokens_per_second: tokens_per_second,
      time_to_first_token_ms: time_to_first_token_ms,
      last_synced_at: new Date()
    };

    const modelData = {
      _id: modelId,
      name: item.name || modelId,
      developer: creatorName,
      context_length: item.contextWindowTokens || item.context_length || rankedInfo?.context_length || null,
      endpoints: [endpointData],
      capabilities: caps,
      evaluations: {
        ...(rankedInfo?.evaluations || {}),
        ...(item.evaluations || {}),
        artificial_analysis_intelligence_index: aa_index_score,
        artificial_analysis_coding_index: coding_score,
        artificial_analysis_math_index: math_score,
        gpqa: rawGpqa !== null && !isNaN(rawGpqa) ? (rawGpqa <= 1 ? rawGpqa * 100 : rawGpqa) : (rankedInfo?.evaluations?.gpqa || null),
        hle: rawHle !== null && !isNaN(rawHle) ? (rawHle <= 1 ? rawHle * 100 : rawHle) : (rankedInfo?.evaluations?.hle || null),
        frontier_code_20: rawFc !== null ? Math.round(rawFc <= 1 ? rawFc * 100 : rawFc) : (rankedInfo?.evaluations?.frontier_code_20 || null),
        terminal_bench_40: rawTb !== null ? Math.round(rawTb <= 1 ? rawTb * 100 : rawTb) : (rankedInfo?.evaluations?.terminal_bench_40 || null),
        livecodebench: item.livecodebench ? Math.round(item.livecodebench <= 1 ? item.livecodebench * 100 : item.livecodebench) : (rankedInfo?.evaluations?.livecodebench || null),
        aime: rawAime !== null && !isNaN(rawAime) ? (rawAime <= 1 ? rawAime * 100 : rawAime) : (rankedInfo?.evaluations?.aime || null),
        coding_agent_index: rawAgents !== null && !isNaN(rawAgents) ? rawAgents : (rankedInfo?.evaluations?.coding_agent_index || null)
      },
      updated_at: new Date()
    };

    syncedModels.push(modelData);
  }

  // Purge existing models from MongoDB collection and insert ONLY the freshly fetched models
  if (mongoose.connection.readyState === 1 && syncedModels.length > 0) {
    try {
      const prevCount = await Model.countDocuments();
      console.log(`🗑️ Database Sync: Purging all ${prevCount} previous models from MongoDB to retain ONLY fresh Artificial Analysis list...`);
      await Model.deleteMany({});
      console.log(`📥 Database Sync: Inserting ONLY the ${syncedModels.length} newly fetched models into MongoDB...`);
      await Model.insertMany(syncedModels, { ordered: false });
      console.log(`✅ Database Sync: MongoDB collection refreshed with ONLY the ${syncedModels.length} new models.`);
    } catch (dbErr) {
      console.error('⚠️ Database Sync: Error replacing models in MongoDB:', dbErr.message);
    }
  }

  // Invalidate multi-tier caches so all APIs return the fresh data immediately
  try {
    const cache = require('./cacheService');
    await cache.del('audex:models:all_docs');
    await cache.del('audex:models:list');
    await cache.del('audex:analysis:raw_data');
    await cache.del('audex:raw_data');
    console.log('🧹 Multi-tier Cache: Invalidated model and raw_data caches.');
  } catch (_) {}

  const prunedLlms = sourceModels.map(m => {
    const creatorName = m.creator?.name || m.model_creator?.name || m.organization || 'Independent';
    const creatorSlug = normalizeCreatorSlug(creatorName, m.creator?.slug || m.model_creator?.slug);
    const slug = m.slug || (m.name ? m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown');
    const modelId = m.modelId || normalizeModelId(creatorSlug, slug);

    const intel = m.intelligenceIndex !== undefined && m.intelligenceIndex !== null
      ? parseFloat(m.intelligenceIndex)
      : (m.evaluations?.artificial_analysis_intelligence_index !== undefined ? parseFloat(m.evaluations.artificial_analysis_intelligence_index) : (m.category_scores?.overall !== undefined ? parseFloat(m.category_scores.overall) : null));

    const lcb = m.livecodebench !== undefined && m.livecodebench !== null ? parseFloat(m.livecodebench) : (m.evaluations?.livecodebench !== undefined ? parseFloat(m.evaluations.livecodebench) : null);
    const codingAgents = m.codingAgentsIndex !== undefined && m.codingAgentsIndex !== null 
      ? parseFloat(m.codingAgentsIndex) 
      : (m.evaluations?.coding_agent_index !== undefined ? parseFloat(m.evaluations.coding_agent_index) : null);
    const coding = codingAgents !== null 
      ? codingAgents 
      : (m.codingIndex !== undefined && m.codingIndex !== null 
        ? parseFloat(m.codingIndex) 
        : (m.evaluations?.artificial_analysis_coding_index !== undefined ? parseFloat(m.evaluations.artificial_analysis_coding_index) : null));

    const aime = m.aime25 !== undefined && m.aime25 !== null ? parseFloat(m.aime25) : (m.evaluations?.aime !== undefined ? parseFloat(m.evaluations.aime) : null);
    const math = m.mathIndex !== undefined && m.mathIndex !== null 
      ? parseFloat(m.mathIndex) 
      : (m.evaluations?.artificial_analysis_math_index !== undefined ? parseFloat(m.evaluations.artificial_analysis_math_index) : (aime !== null ? (aime <= 1 ? aime * 100 : aime) : null));

    const gpqa = m.gpqa !== undefined && m.gpqa !== null ? parseFloat(m.gpqa) : (m.evaluations?.gpqa !== undefined ? parseFloat(m.evaluations.gpqa) : null);
    const hle = m.hle !== undefined && m.hle !== null ? parseFloat(m.hle) : (m.evaluations?.hle !== undefined ? parseFloat(m.evaluations.hle) : null);
    const ifbench = m.ifbench !== undefined && m.ifbench !== null ? parseFloat(m.ifbench) : (m.evaluations?.ifbench !== undefined ? parseFloat(m.evaluations.ifbench) : null);
    const scicode = m.scicode !== undefined && m.scicode !== null ? parseFloat(m.scicode) : (m.evaluations?.scicode !== undefined ? parseFloat(m.evaluations.scicode) : null);
    const mmmuPro = m.mmmuPro !== undefined && m.mmmuPro !== null ? parseFloat(m.mmmuPro) : (m.evaluations?.mmlu_pro !== undefined ? parseFloat(m.evaluations.mmlu_pro) : null);
    const tb = m.terminalBench21 !== undefined && m.terminalBench21 !== null ? parseFloat(m.terminalBench21) : (m.evaluations?.terminalbench_v2_1 !== undefined ? parseFloat(m.evaluations.terminalbench_v2_1) : null);

    const inP = parseFloat(m.price1mInputTokens ?? m.pricing?.price_1m_input_tokens) || 0;
    const outP = parseFloat(m.price1mOutputTokens ?? m.pricing?.price_1m_output_tokens) || 0;

    const tps = m.performanceByPromptType?.medium?.medianOutputSpeed || m.timescaleData?.medianOutputSpeed || m.medianOutputSpeed || m.median_output_tokens_per_second || null;
    const ttft = m.performanceByPromptType?.medium?.medianTimeToFirstAnswerToken || m.performanceByPromptType?.medium?.medianTimeToFirstChunk || m.timescaleData?.medianTimeToFirstChunk || m.medianTimeToFirstAnswerToken || m.median_time_to_first_token_seconds || null;

    return {
      slug: slug,
      modelId: modelId,
      name: m.name || slug,
      model_creator: { name: creatorName, slug: creatorSlug },
      organization: creatorName,
      release_date: m.releaseDate || m.release_date || null,
      rating: m.rating || m.arena_elo || null,
      rank: m.rank || null,
      pricing: {
        price_1m_input_tokens: inP,
        price_1m_output_tokens: outP,
        price_1m_blended_3_to_1: (inP > 0 || outP > 0) ? (inP * 0.75 + outP * 0.25) : 0
      },
      evaluations: {
        artificial_analysis_intelligence_index: intel !== null && !isNaN(intel) ? intel : null,
        artificial_analysis_coding_index: coding !== null && !isNaN(coding) ? coding : null,
        artificial_analysis_math_index: math !== null && !isNaN(math) ? math : null,
        gpqa: gpqa !== null && !isNaN(gpqa) ? (gpqa <= 1 ? gpqa * 100 : gpqa) : null,
        hle: hle !== null && !isNaN(hle) ? (hle <= 1 ? hle * 100 : hle) : null,
        ifbench: ifbench !== null && !isNaN(ifbench) ? (ifbench <= 1 ? ifbench * 100 : ifbench) : null,
        livecodebench: lcb !== null && !isNaN(lcb) ? (lcb <= 1 ? lcb * 100 : lcb) : null,
        aime: aime !== null && !isNaN(aime) ? (aime <= 1 ? aime * 100 : aime) : null,
        scicode: scicode !== null && !isNaN(scicode) ? (scicode <= 1 ? scicode * 100 : scicode) : null,
        mmlu_pro: mmmuPro !== null && !isNaN(mmmuPro) ? (mmmuPro <= 1 ? mmmuPro * 100 : mmmuPro) : null,
        coding_agent_index: codingAgents,
        terminalbench_v2_1: tb !== null && !isNaN(tb) ? (tb <= 1 ? tb * 100 : tb) : null
      },
      median_output_tokens_per_second: tps ? parseFloat(tps) : null,
      median_time_to_first_token_seconds: ttft ? parseFloat(ttft) : null,
      context_length: m.contextWindowTokens || m.context_length || null
    };
  });

  const trimmedCategories = {};
  for (const [catName, catItems] of Object.entries(categories)) {
    if (Array.isArray(catItems)) {
      trimmedCategories[catName] = catItems.map(item => ({
        rank: item.rank || null,
        slug: item.slug,
        modelId: item.modelId,
        name: item.name,
        organization: item.organization || item.model_creator?.name || 'Unknown',
        rating: item.rating || item.arena_elo || null,
        pricing: item.pricing || {
          price_1m_input_tokens: item.price1mInputTokens || 0,
          price_1m_output_tokens: item.price1mOutputTokens || 0
        },
        evaluations: item.evaluations || {},
        category_scores: item.category_scores || {},
        median_output_tokens_per_second: item.median_output_tokens_per_second || null,
        median_time_to_first_token_seconds: item.median_time_to_first_token_seconds || null,
        context_length: item.context_length || null
      }));
    }
  }

  // Save full raw data payload to backend/data/raw_data.json & MongoDB
  const rawData = {
    fetched_at_utc: new Date().toISOString(),
    categories: trimmedCategories,
    sources: {
      llms: {
        status: 200,
        prompt_options: {
          parallel_queries: 1,
          prompt_length: 1000
        },
        data: prunedLlms
      },
      text_to_image: [],
      image_editing: [],
      text_to_speech: [],
      text_to_video: [],
      image_to_video: []
    }
  };

  await saveRawData(rawData);

  // Automatically keep SaaS subscription tiers synchronized with the freshly ingested models
  try {
    const { syncSubscriptionTiers } = require('./subscriptionTierSync');
    await syncSubscriptionTiers(syncedModels);
    console.log('💳 Local Data Sync: Auto-synchronized SaaS subscription tiers with live models.');
  } catch (tierErr) {
    console.warn('⚠️ Local Data Sync: Subscription tier auto-sync warning:', tierErr.message);
  }

  console.log(`✅ Local Data Sync: Successfully synchronized ${syncedModels.length} models and ${Object.keys(trimmedCategories).length} categories.`);
  return syncedModels;
}

module.exports = { syncArtificialAnalysis };
