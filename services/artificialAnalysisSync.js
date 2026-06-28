const fs = require('fs');
const path = require('path');
const Model = require('../models/Model');

// Normalization function to align creator and model slugs with typical baseline identifiers
function normalizeModelId(creator, slug) {
  let c = (creator || 'unknown').toLowerCase();
  let s = (slug || '').toLowerCase();

  if (c === 'meta') c = 'meta-llama';
  if (c === 'mistral') c = 'mistralai';
  if (c === 'xai') c = 'x-ai';

  // Specific baseline alignment normalizations
  if (s === 'claude-35-sonnet') s = 'claude-3-5-sonnet';
  if (s === 'claude-35-haiku') s = 'claude-3-5-haiku';
  if (s === 'gemini-1-5-pro') s = 'gemini-1.5-pro';
  if (s === 'gemini-1-5-flash') s = 'gemini-1.5-flash';

  // Llama series formatting: e.g. llama-3-1-instruct-70b -> llama-3.1-70b-instruct
  if (s.startsWith('llama-')) {
    s = s.replace(/^llama-3-1-instruct-/, 'llama-3.1-');
    s = s.replace(/^llama-3-1-/, 'llama-3.1-');
    s = s.replace(/^llama-3-2-/, 'llama-3.2-');
    s = s.replace(/^llama-3-3-/, 'llama-3.3-');
    s = s.replace(/^llama-4-/, 'llama-4-');
  }

  return `${c}/${s}`;
}

async function syncArtificialAnalysis() {
  console.log('🔄 Local Data Sync: Hydrating models from local rank folder JSON files...');

  const rankDir = path.join(__dirname, '../data/rank');
  if (!fs.existsSync(rankDir)) {
    throw new Error(`Local rank directory not found at: ${rankDir}`);
  }

  const files = fs.readdirSync(rankDir).filter(f => f.endsWith('.json'));
  console.log(`📂 Found ${files.length} JSON files in the rank folder.`);

  const modelsMap = new Map();
  const categories = {};

  // Load and merge models from all JSON files in the rank folder
  for (const file of files) {
    const filePath = path.join(rankDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        const categoryName = file.replace('.json', '');
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
              // Merge evaluations, pricing and details properly
              const existing = modelsMap.get(key);
              existing.evaluations = { ...existing.evaluations, ...model.evaluations };
              if (model.pricing) {
                existing.pricing = { ...existing.pricing, ...model.pricing };
              }
              for (const field of ['median_output_tokens_per_second', 'median_time_to_first_token_seconds', 'median_time_to_first_answer_token', 'context_length', 'license', 'model_url', 'notes', 'primary_benchmark']) {
                if (model[field] !== undefined && model[field] !== null && model[field] !== 0 && model[field] !== '') {
                  existing[field] = model[field];
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`⚠️ Error reading or parsing ${file}:`, err.message);
    }
  }

  const llmModels = Array.from(modelsMap.values());
  console.log(`📥 Processing ${llmModels.length} unique local models for database synchronization...`);

  // Max Observed Values for Direct Relative Percentage Scaling
  const INTEL_MAX = 59.9;
  const CODING_MAX = 76.5;
  const MATH_MAX = 99.0;

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

    // 1. Intelligence Index (aa_index_score)
    let aa_index_score = 0;
    const rawIntel = parseFloat(item.evaluations?.artificial_analysis_intelligence_index);
    if (!isNaN(rawIntel)) {
      aa_index_score = Math.min(100, Math.round(rawIntel));
    }

    // 2. Coding Index Score (coding_score)
    let coding_score = 0;
    const rawCoding = parseFloat(item.evaluations?.artificial_analysis_coding_index);
    if (!isNaN(rawCoding)) {
      coding_score = Math.min(100, Math.round(rawCoding));
    } else {
      coding_score = aa_index_score;
    }

    // 3. Math Index Score (math_score)
    let math_score = 0;
    const rawMath = parseFloat(item.evaluations?.artificial_analysis_math_index);
    if (!isNaN(rawMath)) {
      math_score = Math.min(100, Math.round(rawMath));
    } else {
      math_score = aa_index_score;
    }

    // 4. Reasoning Index Score (reasoning_score)
    let reasoning_score = 0;
    const rawGpqa = parseFloat(item.evaluations?.gpqa);
    const rawHle = parseFloat(item.evaluations?.hle);
    const rawReasoning = !isNaN(rawGpqa) ? rawGpqa : (!isNaN(rawHle) ? rawHle : null);
    if (rawReasoning !== null) {
      reasoning_score = Math.min(100, Math.round(rawReasoning * 100));
    } else {
      reasoning_score = aa_index_score;
    }

    // Speed metrics
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
      console.error(`⚠️ DB Error saving model ${modelId}:`, dbErr.message);
    }
  }

  // Save raw data output structure to data/raw_data.json
  const rawData = {
    fetched_at_utc: new Date().toISOString(),
    categories: categories,
    sources: {
      llms: {
        status: 200,
        prompt_options: {
          parallel_queries: 1,
          prompt_length: 1000
        },
        data: llmModels
      },
      text_to_image: [],
      image_editing: [],
      text_to_speech: [],
      text_to_video: [],
      image_to_video: []
    }
  };

  // Populate media categories from backup raw_data.json if exists
  try {
    const backupPath = path.join(__dirname, '../scratch/raw_data.json');
    if (fs.existsSync(backupPath)) {
      const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      if (backupData.sources) {
        rawData.sources.text_to_image = backupData.sources.text_to_image || [];
        rawData.sources.image_editing = backupData.sources.image_editing || [];
        rawData.sources.text_to_speech = backupData.sources.text_to_speech || [];
        rawData.sources.text_to_video = backupData.sources.text_to_video || [];
        rawData.sources.image_to_video = backupData.sources.image_to_video || [];
      }
    }
  } catch (err) {
    console.error('⚠️ Failed to load media sources from backup raw_data.json:', err.message);
  }

  try {
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputFile = path.join(outputDir, 'raw_data.json');
    fs.writeFileSync(outputFile, JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`💾 Saved local-only raw data cache to: ${outputFile}`);
  } catch (fsErr) {
    console.error('⚠️ Failed to write raw_data.json cache file:', fsErr.message);
  }

  console.log(`✅ Local Data Sync: Successfully synchronized ${syncedModels.length} models and capabilities.`);
  return syncedModels;
}

module.exports = { syncArtificialAnalysis };
