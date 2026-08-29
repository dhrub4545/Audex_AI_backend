const fs = require('fs');
const path = require('path');
const { getRawData, getSubscriptionTiers, saveSubscriptionTiers } = require('./rankStorage');

/**
 * Intelligent Dynamic Model Dispatcher for SaaS Subscription Tiers
 */
function extractAllModels(rawData) {
  const modelMap = new Map();

  // 1. Ingest from sources.llms.data
  const llmData = rawData?.sources?.llms?.data || [];
  llmData.forEach(m => {
    if (m.slug && !modelMap.has(m.slug)) {
      modelMap.set(m.slug, m);
    }
  });

  // 2. Ingest from categories (overall, coding, reasoning, etc.)
  if (rawData?.categories) {
    Object.values(rawData.categories).forEach(catItems => {
      if (Array.isArray(catItems)) {
        catItems.forEach(item => {
          if (item.slug) {
            if (!modelMap.has(item.slug)) {
              modelMap.set(item.slug, item);
            } else {
              const existing = modelMap.get(item.slug);
              if (!existing.rating && item.rating) existing.rating = item.rating;
              if (!existing.name && item.name) existing.name = item.name;
              if (!existing.organization && item.organization) existing.organization = item.organization;
              if (!existing.modelId && item.modelId) existing.modelId = item.modelId;
            }
          }
        });
      }
    });
  }

  return Array.from(modelMap.values());
}

/**
 * Normalizes provider name for matching
 */
function normalizeProvider(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('openai') || n.includes('chatgpt')) return 'openai';
  if (n.includes('anthropic') || n.includes('claude')) return 'anthropic';
  if (n.includes('google') || n.includes('gemini')) return 'google';
  if (n.includes('github') || n.includes('copilot')) return 'github';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('windsurf') || n.includes('codeium')) return 'windsurf';
  if (n.includes('deepseek')) return 'deepseek';
  if (n.includes('mistral')) return 'mistral';
  if (n.includes('meta')) return 'meta';
  if (n.includes('xai') || n.includes('grok') || n.includes('spacexai')) return 'xai';
  if (n.includes('perplexity')) return 'perplexity';
  return 'other';
}

/**
 * Categorize a model into lightweight (mini/flash/haiku/small) vs flagship reasoning
 */
function isLightweightModel(slug, name) {
  const s = `${slug} ${name}`.toLowerCase();
  return s.includes('mini') || s.includes('flash') || s.includes('haiku') || 
         s.includes('small') || s.includes('nano') || s.includes('instant') || 
         s.includes('lite') || s.includes('nemo') || s.includes('3b') || s.includes('8b');
}

/**
 * Categorize a model into max-effort / ultra / heavy reasoning
 */
function isUltraModel(slug, name) {
  const s = `${slug} ${name}`.toLowerCase();
  return s.includes('max') || s.includes('xhigh') || s.includes('ultra') || 
         s.includes('pro-preview') || s.includes('fable') || s.includes('heavy') ||
         s.includes('405b') || s.includes('terra') || s.includes('sol (max)');
}

/**
 * Synchronize subscription_tiers.json with live models from raw_data.json and Artificial Analysis.
 */
async function syncSubscriptionTiers(freshModels = null) {
  console.log('🔄 Subscription Tier Sync: Updating SaaS subscription tiers with live model intelligence...');

  let allModels = [];
  if (Array.isArray(freshModels) && freshModels.length > 0) {
    allModels = freshModels;
  } else {
    const rawData = await getRawData();
    allModels = extractAllModels(rawData);
  }

  console.log(`📊 Processing ${allModels.length} models across all AI providers...`);

  // Sort all models by capability rating descending
  allModels.sort((a, b) => (b.rating || b.arena_elo || 0) - (a.rating || a.arena_elo || 0));

  // Helper to filter models by organization
  const getModelsByOrg = (orgKey) => {
    return allModels.filter(m => {
      const org = (m.organization || m.model_creator?.name || m.model_creator?.slug || '').toLowerCase();
      const slug = (m.slug || '').toLowerCase();
      if (orgKey === 'xai') return org.includes('xai') || org.includes('spacexai') || slug.includes('grok');
      if (orgKey === 'meta') return org.includes('meta') || slug.includes('llama');
      if (orgKey === 'mistral') return org.includes('mistral') || slug.includes('pixtral') || slug.includes('codestral');
      return org.includes(orgKey) || slug.startsWith(orgKey);
    });
  };

  const openAIModels = getModelsByOrg('openai');
  const googleModels = getModelsByOrg('google');
  const anthropicModels = getModelsByOrg('anthropic');
  const deepseekModels = getModelsByOrg('deepseek');
  const mistralModels = getModelsByOrg('mistral');
  const metaModels = getModelsByOrg('meta');
  const xaiModels = getModelsByOrg('xai');

  // Load current tiers
  let currentTiers = await getSubscriptionTiers();
  if (!currentTiers || currentTiers.length === 0) {
    const fallbackPath = path.join(__dirname, '../data/subscription_tiers.json');
    if (fs.existsSync(fallbackPath)) {
      try {
        currentTiers = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      } catch (e) {
        currentTiers = [];
      }
    }
  }

  if (!currentTiers || currentTiers.length === 0) {
    console.warn('⚠️ No subscription tiers found to sync.');
    return [];
  }

  let totalUpdated = 0;

  const updatedTiers = currentTiers.map(tier => {
    const provKey = normalizeProvider(tier.provider);
    const planName = (tier.plan || '').toLowerCase();

    let selectedModels = [];

    // --- 1. OPENAI (ChatGPT) ---
    if (provKey === 'openai') {
      if (planName.includes('free')) {
        selectedModels = openAIModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 4);
      } else if (planName.includes('go')) {
        const light = openAIModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 3);
        const flagship = openAIModels.filter(m => !isLightweightModel(m.slug, m.name)).slice(0, 2);
        selectedModels = [...flagship, ...light];
      } else if (planName.includes('plus') || planName.includes('business')) {
        const flagship = openAIModels.filter(m => !isLightweightModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)).slice(0, 4);
        const ultra = openAIModels.filter(m => isUltraModel(m.slug, m.name)).slice(0, 2);
        selectedModels = [...flagship, ...ultra];
      } else if (planName.includes('pro')) {
        const ultra = openAIModels.filter(m => isUltraModel(m.slug, m.name)).slice(0, 4);
        const flagship = openAIModels.filter(m => !isLightweightModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)).slice(0, 2);
        selectedModels = [...ultra, ...flagship];
      }
    }

    // --- 2. GOOGLE (Gemini & AI Plans) ---
    else if (provKey === 'google') {
      if (planName.includes('free')) {
        selectedModels = googleModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 3);
      } else if (planName.includes('plus')) {
        const light = googleModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 3);
        const flagship = googleModels.filter(m => !isLightweightModel(m.slug, m.name)).slice(0, 2);
        selectedModels = [...light, ...flagship];
      } else if (planName.includes('pro')) {
        const lightFlash = googleModels.filter(m => m.slug.includes('3-7-flash') || m.slug.includes('flash')).slice(0, 2);
        const proPreview = googleModels.filter(m => m.slug.includes('pro') || m.slug.includes('gemma-4')).slice(0, 4);
        selectedModels = [...lightFlash, ...proPreview];
      } else if (planName.includes('ultra')) {
        const ultra = googleModels.filter(m => isUltraModel(m.slug, m.name) || m.slug.includes('3-1-pro') || m.slug.includes('pro') || m.slug.includes('gemma-4')).slice(0, 5);
        selectedModels = ultra;
      }
    }

    // --- 3. ANTHROPIC (Claude) ---
    else if (provKey === 'anthropic') {
      if (planName.includes('free')) {
        selectedModels = anthropicModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 3);
      } else if (planName.includes('pro') || planName.includes('standard')) {
        const opusAndSonnet = anthropicModels.filter(m => !isLightweightModel(m.slug, m.name)).slice(0, 5);
        selectedModels = opusAndSonnet;
      } else if (planName.includes('max') || planName.includes('premium') || planName.includes('enterprise')) {
        const ultraOpus = anthropicModels.filter(m => isUltraModel(m.slug, m.name) || m.slug.includes('opus') || m.slug.includes('fable')).slice(0, 5);
        selectedModels = ultraOpus;
      }
    }

    // --- 4. DEEPSEEK ---
    else if (provKey === 'deepseek') {
      selectedModels = deepseekModels.slice(0, 5);
    }

    // --- 5. MISTRAL ---
    else if (provKey === 'mistral') {
      if (planName.includes('free')) {
        selectedModels = mistralModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 3);
      } else {
        selectedModels = mistralModels.filter(m => !isLightweightModel(m.slug, m.name)).slice(0, 4);
      }
    }

    // --- 6. META ---
    else if (provKey === 'meta') {
      selectedModels = metaModels.slice(0, 4);
    }

    // --- 7. xAI (Grok) ---
    else if (provKey === 'xai') {
      if (planName.includes('free')) {
        selectedModels = xaiModels.filter(m => isLightweightModel(m.slug, m.name) || m.slug.includes('grok-2')).slice(0, 2);
      } else if (planName.includes('heavy') || planName.includes('supergrok')) {
        selectedModels = xaiModels.slice(0, 4);
      } else {
        selectedModels = xaiModels.slice(0, 3);
      }
    }

    // --- 8. DEVELOPER & IDE TOOLS (GitHub Copilot, Cursor, Windsurf) ---
    else if (provKey === 'github' || provKey === 'cursor' || provKey === 'windsurf') {
      if (planName.includes('free')) {
        const topLightClaude = anthropicModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 1);
        const topLightGPT = openAIModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 1);
        selectedModels = [...topLightClaude, ...topLightGPT];
      } else if (planName.includes('pro+') || planName.includes('business')) {
        const topOpus = anthropicModels.filter(m => isUltraModel(m.slug, m.name) || m.slug.includes('opus')).slice(0, 2);
        const topGPT = openAIModels.filter(m => isUltraModel(m.slug, m.name) || m.slug.includes('sol')).slice(0, 2);
        const topGemini = googleModels.filter(m => m.slug.includes('flash') || m.slug.includes('pro')).slice(0, 1);
        selectedModels = [...topOpus, ...topGPT, ...topGemini];
      } else {
        const topClaude = anthropicModels.filter(m => !isLightweightModel(m.slug, m.name)).slice(0, 2);
        const topGPT = openAIModels.filter(m => !isLightweightModel(m.slug, m.name)).slice(0, 2);
        const topGemini = googleModels.filter(m => m.slug.includes('flash') || m.slug.includes('pro')).slice(0, 1);
        selectedModels = [...topClaude, ...topGPT, ...topGemini];
      }
    }

    // --- 9. PERPLEXITY SEARCH ---
    else if (provKey === 'perplexity') {
      const sonarModels = allModels.filter(m => m.slug.includes('sonar'));
      if (planName.includes('free')) {
        selectedModels = sonarModels.length > 0 ? sonarModels.slice(0, 2) : openAIModels.filter(m => isLightweightModel(m.slug, m.name)).slice(0, 2);
      } else {
        const topSonar = sonarModels.slice(0, 2);
        const topOpus = anthropicModels.slice(0, 1);
        const topGPT = openAIModels.slice(0, 1);
        selectedModels = [...topSonar, ...topOpus, ...topGPT];
      }
    }

    // Apply the newly resolved models if matches were found
    if (selectedModels.length > 0) {
      const modelSlugs = selectedModels.map(m => m.modelId || `${normalizeProvider(m.organization || provKey)}/${m.slug}`);
      const rawNames = selectedModels.map(m => m.name || m.slug);

      totalUpdated++;
      return {
        ...tier,
        models: Array.from(new Set(modelSlugs)),
        rawModels: Array.from(new Set(rawNames)),
        last_synced_at: new Date().toISOString()
      };
    }

    // Keep tier as is if no custom dynamic rule matched (e.g. Media/Audio tools)
    return {
      ...tier,
      last_synced_at: tier.last_synced_at || new Date().toISOString()
    };
  });

  // Save the synchronized subscription tiers
  await saveSubscriptionTiers(updatedTiers);

  console.log(`✅ Subscription Tier Sync: Successfully refreshed ${updatedTiers.length} tiers (${totalUpdated} providers updated with top live models).`);
  return updatedTiers;
}

module.exports = { syncSubscriptionTiers };
