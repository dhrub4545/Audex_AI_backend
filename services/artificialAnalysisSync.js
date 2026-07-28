const fs = require('fs');
const path = require('path');
const Model = require('../models/Model');
const { saveRawData, getRankCategory } = require('./rankStorage');
const { ALL_30_CATEGORIES } = require('../audex-ai/algorithms/overall_score');

// Normalization function to align creator and model slugs
function normalizeModelId(creator, slug) {
  let c = (creator || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let s = (slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  if (c === 'meta') c = 'meta-llama';
  if (c === 'mistral') c = 'mistralai';
  if (c === 'xai') c = 'x-ai';

  if (s === 'claude-35-sonnet') s = 'claude-3-5-sonnet';
  if (s === 'claude-35-haiku') s = 'claude-3-5-haiku';
  if (s === 'gemini-1-5-pro') s = 'gemini-1.5-pro';
  if (s === 'gemini-1-5-flash') s = 'gemini-1.5-flash';

  return `${c}/${s}`;
}

async function syncArtificialAnalysis(scrapedModels = null) {
  console.log('🔄 Local Data Sync: Synchronizing Artificial Analysis models & updating raw_data.json...');

  const modelsMap = new Map();
  const categories = {};

  // Load and merge models from all 30 rank categories via rankStorage (MongoDB Atlas / local disk fallback)
  for (const categoryName of ALL_30_CATEGORIES) {
    try {
      const data = await getRankCategory(categoryName);
      if (Array.isArray(data)) {
        categories[categoryName] = data.map(item => {
          const creatorSlug = item.model_creator?.slug || 'unknown';
          const modelId = normalizeModelId(creatorSlug, item.slug);
          return {
            ...item,
            rank: item.rank,
            slug: item.slug,
            modelId: modelId,
            name: item.name || item.model_name || item.slug,
            organization: item.organization || item.model_creator?.name || 'Unknown',
            rating: item.rating || item.arena_elo || 0
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

    const creatorSlug = item.model_creator?.slug || 'unknown';
    const modelId = normalizeModelId(creatorSlug, item.slug);

    const inputCostPerM = parseFloat(item.pricing?.price_1m_input_tokens || 0);
    const outputCostPerM = parseFloat(item.pricing?.price_1m_output_tokens || 0);

    const endpointData = {
      provider_name: 'Artificial Analysis',
      input_cost_per_m: isNaN(inputCostPerM) ? 0 : inputCostPerM,
      output_cost_per_m: isNaN(outputCostPerM) ? 0 : outputCostPerM,
      cache_read_cost_per_m: 0,
      is_active: true,
      last_synced_at: new Date()
    };

    let aa_index_score = 0;
    const rawIntel = parseFloat(item.evaluations?.artificial_analysis_intelligence_index);
    if (!isNaN(rawIntel)) {
      aa_index_score = Math.min(100, Math.round(rawIntel));
    }

    let coding_score = 0;
    const rawCoding = parseFloat(item.evaluations?.artificial_analysis_coding_index);
    if (!isNaN(rawCoding)) {
      coding_score = Math.min(100, Math.round(rawCoding));
    } else {
      coding_score = aa_index_score;
    }

    let math_score = 0;
    const rawMath = parseFloat(item.evaluations?.artificial_analysis_math_index);
    if (!isNaN(rawMath)) {
      math_score = Math.min(100, Math.round(rawMath));
    } else {
      math_score = aa_index_score;
    }

    let reasoning_score = 0;
    const rawGpqa = parseFloat(item.evaluations?.gpqa);
    const rawHle = parseFloat(item.evaluations?.hle);
    const rawReasoning = !isNaN(rawGpqa) ? rawGpqa : (!isNaN(rawHle) ? rawHle : null);
    if (rawReasoning !== null) {
      reasoning_score = Math.min(100, Math.round(rawReasoning * 100));
    } else {
      reasoning_score = aa_index_score;
    }

    let tokens_per_second = 0;
    if (item.median_output_tokens_per_second !== null && item.median_output_tokens_per_second !== undefined) {
      const val = parseFloat(item.median_output_tokens_per_second);
      if (!isNaN(val) && val > 0) {
        tokens_per_second = Math.round(val);
      }
    }

    let time_to_first_token_ms = 0;
    if (item.median_time_to_first_token_seconds !== null && item.median_time_to_first_token_seconds !== undefined) {
      const val = parseFloat(item.median_time_to_first_token_seconds);
      if (!isNaN(val) && val > 0) {
        time_to_first_token_ms = Math.round(val * 1000);
      }
    }

    const caps = {
      aa_index_score,
      coding_score,
      math_score,
      reasoning_score,
      tokens_per_second,
      time_to_first_token_ms,
      last_synced_at: new Date()
    };

    const modelData = {
      _id: modelId,
      name: item.name || modelId,
      developer: item.model_creator?.name || creatorSlug,
      context_length: item.context_length || 128000,
      endpoints: [endpointData],
      capabilities: caps,
      updated_at: new Date()
    };

    syncedModels.push(modelData);

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
            updated_at: modelData.updated_at
          }
         },
         { upsert: true, new: true }
      );
    } catch (dbErr) {
      // Ignore DB errors if offline/no mongo connection
    }
  }

  const prunedLlms = (scrapedModels || llmModels).map(m => {
    const intel = m.evaluations?.artificial_analysis_intelligence_index !== undefined ? m.evaluations.artificial_analysis_intelligence_index : (m.intelligenceIndex !== undefined ? m.intelligenceIndex : m.category_scores?.overall);
    const coding = m.evaluations?.artificial_analysis_coding_index !== undefined ? m.evaluations.artificial_analysis_coding_index : (m.codingIndex !== undefined ? m.codingIndex : m.category_scores?.coding);
    const math = m.evaluations?.artificial_analysis_math_index !== undefined ? m.evaluations.artificial_analysis_math_index : (m.mathIndex !== undefined ? m.mathIndex : m.category_scores?.math);

    return {
      slug: m.slug,
      name: m.name,
      model_creator: m.model_creator || { name: m.creator?.name || m.organization || 'Unknown', slug: m.creator?.slug || '' },
      release_date: m.release_date,
      pricing: m.pricing || {
        price_1m_input_tokens: m.price1mInputTokens || 0,
        price_1m_output_tokens: m.price1mOutputTokens || 0
      },
      evaluations: {
        artificial_analysis_intelligence_index: intel !== undefined ? intel : null,
        artificial_analysis_coding_index: coding !== undefined ? coding : null,
        artificial_analysis_math_index: math !== undefined ? math : null,
        gpqa: m.evaluations?.gpqa ?? m.gpqa ?? null,
        hle: m.evaluations?.hle ?? m.hle ?? null
      },
      median_output_tokens_per_second: m.median_output_tokens_per_second || m.performanceByPromptType?.medium?.medianOutputSpeed || null,
      median_time_to_first_token_seconds: m.median_time_to_first_token_seconds || m.performanceByPromptType?.medium?.medianTimeToFirstAnswerToken || null
    };
  });

  const trimmedCategories = {};
  for (const [catName, catItems] of Object.entries(categories)) {
    if (Array.isArray(catItems)) {
      trimmedCategories[catName] = catItems.map(item => ({
        rank: item.rank,
        slug: item.slug,
        modelId: item.modelId,
        name: item.name,
        organization: item.organization || item.model_creator?.name || 'Unknown',
        rating: item.rating || item.arena_elo || 0,
        pricing: item.pricing || {
          price_1m_input_tokens: item.price1mInputTokens || 0,
          price_1m_output_tokens: item.price1mOutputTokens || 0
        },
        evaluations: item.evaluations || {
          artificial_analysis_intelligence_index: item.category_scores?.[catName] || item.final_score || null,
          artificial_analysis_coding_index: item.category_scores?.coding || null,
          artificial_analysis_math_index: item.category_scores?.math || null,
          gpqa: item.evaluations?.gpqa || null,
          hle: item.evaluations?.hle || null
        },
        median_output_tokens_per_second: item.median_output_tokens_per_second || null,
        median_time_to_first_token_seconds: item.median_time_to_first_token_seconds || null
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

  console.log(`✅ Local Data Sync: Successfully synchronized ${syncedModels.length} models and capabilities.`);
  return syncedModels;
}

module.exports = { syncArtificialAnalysis };
