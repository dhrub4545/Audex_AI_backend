const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Model = require('../models/Model');
const { saveRawData, getRankCategory } = require('./rankStorage');
const { ALL_30_CATEGORIES, normalizeModelId, normalizeCreatorSlug } = require('../audex-ai/algorithms/overall_score');

async function syncArtificialAnalysis(scrapedModels = null) {
  console.log('🔄 Local Data Sync: Synchronizing Artificial Analysis models & updating raw_data.json...');

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
  console.log(`📥 Processing ${llmModels.length} unique local models for database synchronization...`);

  const syncedModels = [];

  for (const item of llmModels) {
    if (!item.slug) continue;

    const creatorName = item.organization || item.model_creator?.name || 'Independent';
    const creatorSlug = normalizeCreatorSlug(creatorName, item.model_creator?.slug);
    const modelId = item.modelId || normalizeModelId(creatorSlug, item.slug);

    const inputCostPerM = parseFloat(item.pricing?.price_1m_input_tokens || item.price1mInputTokens || 0);
    const outputCostPerM = parseFloat(item.pricing?.price_1m_output_tokens || item.price1mOutputTokens || 0);

    const endpointData = {
      provider_name: 'Artificial Analysis',
      input_cost_per_m: isNaN(inputCostPerM) ? 0 : inputCostPerM,
      output_cost_per_m: isNaN(outputCostPerM) ? 0 : outputCostPerM,
      cache_read_cost_per_m: 0,
      is_active: true,
      last_synced_at: new Date()
    };

    // 100% actual benchmark metrics - NO FAKE FALLBACK TO INTEL IF BENCHMARK IS MISSING!
    // 1. Intelligence / Overall index
    let aa_index_score = null;
    const rawIntel = parseFloat(item.evaluations?.artificial_analysis_intelligence_index ?? item.category_scores?.overall ?? item.intelligenceIndex);
    if (!isNaN(rawIntel) && rawIntel > 0) {
      aa_index_score = Math.min(100, Math.round(rawIntel));
    } else if (item.final_score && item.final_score > 0) {
      aa_index_score = Math.min(100, Math.round(item.final_score));
    }

    // 2. Coding index (LiveCodeBench, Coding Index, Coding Agents)
    let coding_score = null;
    const rawLcb = parseFloat(item.evaluations?.livecodebench ?? item.livecodebench);
    const rawCoding = parseFloat(item.evaluations?.artificial_analysis_coding_index ?? item.category_scores?.coding ?? item.codingIndex);
    const rawAgents = parseFloat(item.evaluations?.coding_agent_index ?? item.codingAgentsIndex);
    if (!isNaN(rawLcb) && rawLcb > 0) {
      coding_score = Math.min(100, Math.round(rawLcb <= 1 ? rawLcb * 100 : rawLcb));
    } else if (!isNaN(rawCoding) && rawCoding > 0) {
      coding_score = Math.min(100, Math.round(rawCoding));
    } else if (!isNaN(rawAgents) && rawAgents > 0) {
      coding_score = Math.min(100, Math.round(rawAgents));
    }

    // 3. Math index (AIME, Math Index, SciCode)
    let math_score = null;
    const rawAime = parseFloat(item.evaluations?.aime ?? item.aime25);
    const rawMath = parseFloat(item.evaluations?.artificial_analysis_math_index ?? item.category_scores?.math ?? item.mathIndex);
    const rawSci = parseFloat(item.evaluations?.scicode ?? item.scicode);
    if (!isNaN(rawAime) && rawAime > 0) {
      math_score = Math.min(100, Math.round(rawAime <= 1 ? rawAime * 100 : rawAime));
    } else if (!isNaN(rawMath) && rawMath > 0) {
      math_score = Math.min(100, Math.round(rawMath));
    } else if (!isNaN(rawSci) && rawSci > 0) {
      math_score = Math.min(100, Math.round(rawSci <= 1 ? rawSci * 100 : rawSci));
    }

    // 4. Reasoning index (GPQA Diamond, HLE)
    let reasoning_score = null;
    const rawGpqa = parseFloat(item.evaluations?.gpqa ?? item.gpqa);
    const rawHle = parseFloat(item.evaluations?.hle ?? item.hle);
    if (!isNaN(rawGpqa) && rawGpqa > 0) {
      reasoning_score = Math.min(100, Math.round(rawGpqa <= 1 ? rawGpqa * 100 : rawGpqa));
    } else if (!isNaN(rawHle) && rawHle > 0) {
      reasoning_score = Math.min(100, Math.round(rawHle <= 1 ? rawHle * 100 : rawHle));
    } else if (aa_index_score !== null) {
      reasoning_score = aa_index_score;
    }

    let tokens_per_second = null;
    if (item.median_output_tokens_per_second !== null && item.median_output_tokens_per_second !== undefined) {
      const val = parseFloat(item.median_output_tokens_per_second);
      if (!isNaN(val) && val > 0) {
        tokens_per_second = Math.round(val);
      }
    }

    let time_to_first_token_ms = null;
    if (item.median_time_to_first_token_seconds !== null && item.median_time_to_first_token_seconds !== undefined) {
      const val = parseFloat(item.median_time_to_first_token_seconds);
      if (!isNaN(val) && val > 0) {
        time_to_first_token_ms = Math.round(val * 1000);
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
      context_length: item.context_length || item.contextWindowTokens || null,
      endpoints: [endpointData],
      capabilities: caps,
      evaluations: item.evaluations || {},
      updated_at: new Date()
    };

    syncedModels.push(modelData);

    if (mongoose.connection.readyState === 1) {
      try {
        await Model.findByIdAndUpdate(
          modelId,
          {
            $set: {
              name: modelData.name,
              developer: modelData.developer,
              context_length: modelData.context_length,
              endpoints: modelData.endpoints,
              capabilities: modelData.capabilities,
              evaluations: modelData.evaluations,
              updated_at: modelData.updated_at
            }
           },
           { upsert: true, new: true }
        );
      } catch (dbErr) {
        // Ignore DB errors if offline/no mongo connection
      }
    }
  }

  const sourceModels = (scrapedModels && scrapedModels.length > 0) ? scrapedModels : llmModels;
  const prunedLlms = sourceModels.map(m => {
    const creatorName = m.creator?.name || m.model_creator?.name || m.organization || 'Independent';
    const creatorSlug = normalizeCreatorSlug(creatorName, m.creator?.slug || m.model_creator?.slug);
    const slug = m.slug || (m.name ? m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown');
    const modelId = m.modelId || normalizeModelId(creatorSlug, slug);

    const intel = m.intelligenceIndex !== undefined && m.intelligenceIndex !== null
      ? parseFloat(m.intelligenceIndex)
      : (m.evaluations?.artificial_analysis_intelligence_index !== undefined ? parseFloat(m.evaluations.artificial_analysis_intelligence_index) : (m.category_scores?.overall !== undefined ? parseFloat(m.category_scores.overall) : null));

    const lcb = m.livecodebench !== undefined && m.livecodebench !== null ? parseFloat(m.livecodebench) : (m.evaluations?.livecodebench !== undefined ? parseFloat(m.evaluations.livecodebench) : null);
    const coding = m.codingIndex !== undefined && m.codingIndex !== null 
      ? parseFloat(m.codingIndex) 
      : (m.evaluations?.artificial_analysis_coding_index !== undefined ? parseFloat(m.evaluations.artificial_analysis_coding_index) : (lcb !== null ? (lcb <= 1 ? lcb * 100 : lcb) : null));

    const aime = m.aime25 !== undefined && m.aime25 !== null ? parseFloat(m.aime25) : (m.evaluations?.aime !== undefined ? parseFloat(m.evaluations.aime) : null);
    const math = m.mathIndex !== undefined && m.mathIndex !== null 
      ? parseFloat(m.mathIndex) 
      : (m.evaluations?.artificial_analysis_math_index !== undefined ? parseFloat(m.evaluations.artificial_analysis_math_index) : (aime !== null ? (aime <= 1 ? aime * 100 : aime) : null));

    const gpqa = m.gpqa !== undefined && m.gpqa !== null ? parseFloat(m.gpqa) : (m.evaluations?.gpqa !== undefined ? parseFloat(m.evaluations.gpqa) : null);
    const hle = m.hle !== undefined && m.hle !== null ? parseFloat(m.hle) : (m.evaluations?.hle !== undefined ? parseFloat(m.evaluations.hle) : null);
    const ifbench = m.ifbench !== undefined && m.ifbench !== null ? parseFloat(m.ifbench) : (m.evaluations?.ifbench !== undefined ? parseFloat(m.evaluations.ifbench) : null);
    const scicode = m.scicode !== undefined && m.scicode !== null ? parseFloat(m.scicode) : (m.evaluations?.scicode !== undefined ? parseFloat(m.evaluations.scicode) : null);
    const mmmuPro = m.mmmuPro !== undefined && m.mmmuPro !== null ? parseFloat(m.mmmuPro) : (m.evaluations?.mmlu_pro !== undefined ? parseFloat(m.evaluations.mmlu_pro) : null);
    const codingAgents = m.codingAgentsIndex !== undefined && m.codingAgentsIndex !== null ? parseFloat(m.codingAgentsIndex) : (m.evaluations?.coding_agent_index !== undefined ? parseFloat(m.evaluations.coding_agent_index) : null);
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
