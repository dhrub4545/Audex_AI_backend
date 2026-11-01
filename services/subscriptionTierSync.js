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
              if (!existing.release_date && item.release_date) existing.release_date = item.release_date;
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
  if (n.includes('alibaba') || n.includes('qwen')) return 'alibaba';
  if (n.includes('cohere')) return 'cohere';
  if (n.includes('amazon') || n.includes('bedrock') || n.includes('nova')) return 'amazon';
  if (n.includes('microsoft')) return 'microsoft';
  return 'other';
}

/**
 * Categorize a model into lightweight (mini/flash/haiku/small) vs flagship reasoning.
 * Uses strict token-based regex to avoid matching substrings like "gemini" with "mini".
 */
function isLightweightModel(slug = '', name = '') {
  const s = `${slug} ${name}`.toLowerCase();
  
  // Explicitly NEVER lightweight if it's a known flagship or ultra frontier model:
  if (s.includes('carbon') || s.includes('argon') || s.includes('terra') || 
      s.includes('opus') || s.includes('large') || s.includes('sol') || 
      s.includes('grok 4.7') || s.includes('grok-4-7') || s.includes('405b') ||
      s.includes('397b') || s.includes('480b')) {
    return false;
  }
  
  // Word boundary matching for 'mini' so 'gemini' does not match
  const hasMini = /\bmini\b|-mini\b|\bmini-/.test(s);
  const hasFlash = /\bflash\b|-flash\b|\bflash-/.test(s);
  const hasHaiku = /\bhaiku\b/.test(s);
  const hasNano = /\bnano\b/.test(s);
  const hasSmall = /\bsmall\b/.test(s);
  const hasLite = /\blite\b|-lite\b|\blite-/.test(s);
  const hasInstant = /\binstant\b/.test(s);
  const hasFast = /\bfast\b/.test(s);
  const hasSmallParams = /\b(?:1b|2b|3b|4b|7b|8b|9b|12b|14b)\b/.test(s);

  return hasMini || hasFlash || hasHaiku || hasNano || hasSmall || hasLite || hasInstant || hasFast || hasSmallParams;
}

/**
 * Categorize a model into max-effort / ultra / heavy reasoning
 */
function isUltraModel(slug = '', name = '') {
  const s = `${slug} ${name}`.toLowerCase();
  if (isLightweightModel(slug, name)) return false;
  return s.includes('carbon') || s.includes('terra') || 
         s.includes('opus 5.5') || s.includes('opus 5') || s.includes('opus-5') ||
         s.includes('grok 4.7') || s.includes('grok-4-7') ||
         s.includes('heavy') || s.includes('405b') || s.includes('480b') ||
         s.includes('397b') || (s.includes('sol') && s.includes('max')) ||
         (s.includes('ultra') && !s.includes('1.0')) || s.includes('deep-think') ||
         (s.includes('xhigh') && (s.includes('terra') || s.includes('opus') || s.includes('grok 4.7')));
}

/**
 * Categorize a model into standard flagship tier (Pro / Plus / Sonnet / Sol / Large)
 */
function isFlagshipModel(slug = '', name = '') {
  const s = `${slug} ${name}`.toLowerCase();
  if (isLightweightModel(slug, name)) return false;
  return s.includes('argon') || s.includes('sol') || s.includes('sonnet') || 
         s.includes('pro') || s.includes('large') || s.includes('medium') ||
         s.includes('grok 4.6') || s.includes('grok-4-6') || s.includes('v4-pro') ||
         s.includes('command a') || s.includes('speciale') || isUltraModel(slug, name);
}

/**
 * Check if a model is deprecated, outdated, or discontinued from active subscriptions
 */
function isDiscontinuedModel(name = '', slug = '') {
  const s = `${name} ${slug}`.toLowerCase();
  // Deprecated date-stamped models that have been superseded
  if (s.includes("dec '24") || s.includes("dec 24") || s.includes("apr '24") || s.includes("apr 24") || s.includes("mar '25") || s.includes("may '25")) return true;
  
  // Explicitly discontinued / deprecated older generations
  if (s.includes('gpt-3') || s.includes('gpt-3.5') || s.includes('gpt-4-0') || s.includes('o1-preview') || s.includes('o1-mini')) return true;
  if (s.includes('claude-1') || s.includes('claude-2') || s.includes('claude 1') || s.includes('claude 2') || s.includes('claude-instant')) return true;
  if (s.includes('gemini-1.0') || s.includes('gemini 1.0') || s.includes('pro-vision') || s.includes('gemini-3-pro') || s.includes('gemini 3 pro') || s.includes('gemini-3-1-pro') || s.includes('gemini 3.1 pro')) return true;
  if (s.includes('grok 2') || s.includes('grok-2') || s.includes('grok-1') || s.includes('grok 1')) return true;
  if (s.includes('midjourney v6') || s.includes('midjourney v5') || s.includes('niji 6') || s.includes('niji 5')) return true;
  if (s.includes('suno v4.5+') || s.includes('suno v4.5 ') || s.includes('suno v3')) return true;
  if (s.trim() === 'gen-4' || s.includes('gen-3') || s.includes('gen-2')) return true;
  if (s.includes('command-r+') && s.includes('24')) return true;
  return false;
}

let globalDateMap = {};

function initDateMap(models = []) {
  globalDateMap = {};
  models.forEach(m => {
    if (m.release_date) {
      if (m.name) globalDateMap[m.name.toLowerCase().trim()] = m.release_date;
      if (m.slug) globalDateMap[m.slug.toLowerCase().trim()] = m.release_date;
    }
  });
}

/**
 * Calculates a recency score for sorting models with the latest models first.
 */
function getModelRecencyScore(name = '', slug = '', releaseDate = null) {
  const s = `${name} ${slug}`.toLowerCase();
  if (releaseDate) return new Date(releaseDate).getTime();
  const cleanName = (name || '').toLowerCase().trim();
  const cleanSlug = (slug || '').toLowerCase().trim();
  if (globalDateMap[cleanName] || globalDateMap[cleanSlug]) {
    return new Date(globalDateMap[cleanName] || globalDateMap[cleanSlug]).getTime();
  }
  let score = new Date('2025-01-01').getTime();
  const versionMatch = s.match(/(?:v|version|gpt-|claude |gemini |grok |deepseek v|qwen|suno v|midjourney v|gen-)(\d+(?:\.\d+)?)/i);
  if (versionMatch) {
    const v = parseFloat(versionMatch[1]);
    score += v * 10000000000;
  }
  if (s.includes('terra') || s.includes('sol (max)') || s.includes('opus 5') || s.includes('carbon') || s.includes('grok 4.7')) {
    score += 5000000000;
  } else if (s.includes('xhigh') || s.includes('ultra') || s.includes('max')) {
    score += 2000000000;
  } else if (s.includes('high') || s.includes('pro')) {
    score += 1000000000;
  } else if (s.includes('medium') || s.includes('plus')) {
    score += 500000000;
  } else if (s.includes('mini') || s.includes('flash') || s.includes('haiku') || s.includes('low') || s.includes('small') || s.includes('nano')) {
    score -= 1000000000;
  }
  return score;
}

/**
 * Helper to pick distinct, diverse models across model families.
 * Avoids returning 3 slight variations of the same model (e.g. High, Medium, Low).
 */
function pickDiverseModels(models, maxCount = 4) {
  const result = [];
  const seenFamilies = new Set();
  
  for (const m of models) {
    const familyKey = (m.name || m.slug || '').toLowerCase()
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/-high|-medium|-low|-preview|-reasoning|-non-reasoning/g, '')
      .trim();
    if (!seenFamilies.has(familyKey)) {
      seenFamilies.add(familyKey);
      result.push(m);
      if (result.length >= maxCount) break;
    }
  }
  
  if (result.length < maxCount) {
    const seenSlugs = new Set(result.map(m => m.slug));
    for (const m of models) {
      if (!seenSlugs.has(m.slug)) {
        seenSlugs.add(m.slug);
        result.push(m);
        if (result.length >= maxCount) break;
      }
    }
  }
  return result;
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

  // Initialize date mapping for accurate recency resolution
  initDateMap(allModels);

  // Filter out any discontinued models and sort all models LATEST FIRST
  allModels = allModels.filter(m => !isDiscontinuedModel(m.name, m.slug));
  allModels.sort((a, b) => {
    const scoreA = getModelRecencyScore(a.name, a.slug, a.release_date);
    const scoreB = getModelRecencyScore(b.name, b.slug, b.release_date);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.rating || b.arena_elo || 0) - (a.rating || a.arena_elo || 0);
  });

  // Helper to filter models by organization
  const getModelsByOrg = (orgKey) => {
    return allModels.filter(m => {
      const org = (m.organization || m.model_creator?.name || m.model_creator?.slug || '').toLowerCase();
      const slug = (m.slug || '').toLowerCase();
      if (orgKey === 'xai') return org.includes('xai') || org.includes('spacexai') || slug.includes('grok');
      if (orgKey === 'meta') return org.includes('meta') || slug.includes('llama') || slug.includes('muse');
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
  const alibabaModels = getModelsByOrg('alibaba');
  const cohereModels = getModelsByOrg('cohere');

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

  // Auto-discover and ensure prominent AI providers exist in subscription list
  const existingProviders = new Set(currentTiers.map(t => normalizeProvider(t.provider)));
  if (!existingProviders.has('alibaba') && alibabaModels.length > 0) {
    currentTiers.push({
      category: 'Chat & Reasoning',
      provider: 'Alibaba (Qwen)',
      plan: 'Qwen Chat Pro',
      monthlyPrice: 15,
      annualPrice: 150,
      annualPriceEquiv: 12.5,
      annualDiscount: true,
      isPerSeat: false,
      models: alibabaModels.slice(0, 4).map(m => m.modelId || `alibaba/${m.slug}`),
      rawModels: alibabaModels.slice(0, 4).map(m => m.name || m.slug),
      limits: 'Access to flagship Qwen models with fast inference.',
      last_synced_at: new Date().toISOString()
    });
    existingProviders.add('alibaba');
  }
  if (!existingProviders.has('cohere') && cohereModels.length > 0) {
    currentTiers.push({
      category: 'Chat & Reasoning',
      provider: 'Cohere',
      plan: 'Cohere Platform',
      monthlyPrice: 20,
      annualPrice: 200,
      annualPriceEquiv: 16.6,
      annualDiscount: true,
      isPerSeat: false,
      models: cohereModels.slice(0, 4).map(m => m.modelId || `cohere/${m.slug}`),
      rawModels: cohereModels.slice(0, 4).map(m => m.name || m.slug),
      limits: 'Access to Command R and R+ models with enterprise grounding.',
      last_synced_at: new Date().toISOString()
    });
    existingProviders.add('cohere');
  }

  let totalUpdated = 0;

  const updatedTiers = currentTiers.map(tier => {
    const provKey = normalizeProvider(tier.provider);
    const planName = (tier.plan || '').toLowerCase();

    let selectedModels = [];

    // --- 1. OPENAI (ChatGPT) ---
    if (provKey === 'openai') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(openAIModels.filter(m => isLightweightModel(m.slug, m.name)), 4);
      } else if (planName.includes('go')) {
        selectedModels = pickDiverseModels([
          ...openAIModels.filter(m => isLightweightModel(m.slug, m.name)),
          ...openAIModels.filter(m => m.slug.includes('5-2') || m.slug.includes('instant'))
        ], 4);
      } else if (planName.includes('plus')) {
        selectedModels = pickDiverseModels(openAIModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 5);
      } else if (planName.includes('pro') || planName.includes('business')) {
        selectedModels = pickDiverseModels([
          ...openAIModels.filter(m => isUltraModel(m.slug, m.name)),
          ...openAIModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name))
        ], 5);
      }
    }

    // --- 2. GOOGLE (Gemini & AI Plans) ---
    else if (provKey === 'google') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(googleModels.filter(m => isLightweightModel(m.slug, m.name) && (m.slug.includes('flash') || m.name.toLowerCase().includes('flash'))), 3);
      } else if (planName.includes('plus')) {
        const lightFlash = pickDiverseModels(googleModels.filter(m => isLightweightModel(m.slug, m.name) && (m.slug.includes('flash') || m.name.toLowerCase().includes('flash'))), 2);
        const reasoning = pickDiverseModels(googleModels.filter(m => m.slug.includes('flash-reasoning') || m.slug.includes('31b') || m.slug.includes('26b')), 2);
        selectedModels = pickDiverseModels([...lightFlash, ...reasoning], 4);
      } else if (planName.includes('pro')) {
        const flagship = pickDiverseModels(googleModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 3);
        const flash = pickDiverseModels(googleModels.filter(m => m.slug.includes('3-8-flash') || m.slug.includes('3-7-flash')), 1);
        selectedModels = pickDiverseModels([...flagship, ...flash], 4);
      } else if (planName.includes('ultra')) {
        const ultra = pickDiverseModels(googleModels.filter(m => isUltraModel(m.slug, m.name)), 2);
        const flagship = pickDiverseModels(googleModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 2);
        selectedModels = pickDiverseModels([...ultra, ...flagship], 4);
      }
    }

    // --- 3. ANTHROPIC (Claude) ---
    else if (provKey === 'anthropic') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(anthropicModels.filter(m => isLightweightModel(m.slug, m.name)), 3);
      } else if (planName.includes('pro') || planName.includes('standard')) {
        selectedModels = pickDiverseModels(anthropicModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 4);
      } else if (planName.includes('max') || planName.includes('premium') || planName.includes('enterprise')) {
        selectedModels = pickDiverseModels([
          ...anthropicModels.filter(m => isUltraModel(m.slug, m.name)),
          ...anthropicModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name))
        ], 4);
      }
    }

    // --- 4. DEEPSEEK ---
    else if (provKey === 'deepseek') {
      selectedModels = pickDiverseModels(deepseekModels, 5);
    }

    // --- 5. MISTRAL ---
    else if (provKey === 'mistral') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(mistralModels.filter(m => isLightweightModel(m.slug, m.name)), 3);
      } else {
        selectedModels = pickDiverseModels(mistralModels.filter(m => !isLightweightModel(m.slug, m.name)), 4);
      }
    }

    // --- 6. META ---
    else if (provKey === 'meta') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(metaModels.filter(m => isLightweightModel(m.slug, m.name) || m.slug.includes('70b') || m.slug.includes('spark')), 3);
      } else {
        selectedModels = pickDiverseModels(metaModels.filter(m => isUltraModel(m.slug, m.name) || m.slug.includes('405b') || m.slug.includes('wonder')), 4);
      }
    }

    // --- 7. xAI (Grok) ---
    else if (provKey === 'xai') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(xaiModels.filter(m => isLightweightModel(m.slug, m.name)), 2);
      } else if (planName.includes('heavy') || (planName.includes('supergrok') && !planName.includes('lite'))) {
        selectedModels = pickDiverseModels([
          ...xaiModels.filter(m => isUltraModel(m.slug, m.name)),
          ...xaiModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name))
        ], 4);
      } else {
        selectedModels = pickDiverseModels(xaiModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 3);
      }
    }

    // --- 8. DEVELOPER & IDE TOOLS (GitHub Copilot, Cursor, Windsurf) ---
    else if (provKey === 'github' || provKey === 'cursor' || provKey === 'windsurf') {
      if (planName.includes('free')) {
        const topLightClaude = pickDiverseModels(anthropicModels.filter(m => isLightweightModel(m.slug, m.name)), 1);
        const topLightGPT = pickDiverseModels(openAIModels.filter(m => isLightweightModel(m.slug, m.name)), 1);
        const topLightGemini = pickDiverseModels(googleModels.filter(m => isLightweightModel(m.slug, m.name)), 1);
        selectedModels = [...topLightClaude, ...topLightGPT, ...topLightGemini];
      } else if (planName.includes('pro+') || planName.includes('business')) {
        const topOpus = pickDiverseModels(anthropicModels.filter(m => isUltraModel(m.slug, m.name)), 1);
        const topGPT = pickDiverseModels(openAIModels.filter(m => isUltraModel(m.slug, m.name)), 1);
        const topSonnet = pickDiverseModels(anthropicModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        const topGemini = pickDiverseModels(googleModels.filter(m => isUltraModel(m.slug, m.name) || m.slug.includes('argon')), 1);
        selectedModels = [...topOpus, ...topGPT, ...topSonnet, ...topGemini];
      } else {
        const topClaude = pickDiverseModels(anthropicModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        const topGPT = pickDiverseModels(openAIModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        const topGemini = pickDiverseModels(googleModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        selectedModels = [...topClaude, ...topGPT, ...topGemini];
      }
    }

    // --- 9. PERPLEXITY SEARCH ---
    else if (provKey === 'perplexity') {
      const sonarModels = allModels.filter(m => m.slug.includes('sonar'));
      if (planName.includes('free')) {
        const sLight = sonarModels.slice(0, 1);
        const gLight = pickDiverseModels(googleModels.filter(m => isLightweightModel(m.slug, m.name)), 1);
        const aLight = pickDiverseModels(anthropicModels.filter(m => isLightweightModel(m.slug, m.name)), 1);
        selectedModels = [...sLight, ...gLight, ...aLight];
      } else if (planName.includes('max')) {
        const sTop = sonarModels.slice(0, 1);
        const aOpus = pickDiverseModels(anthropicModels.filter(m => isUltraModel(m.slug, m.name)), 1);
        const oTerra = pickDiverseModels(openAIModels.filter(m => isUltraModel(m.slug, m.name)), 1);
        const gCarbon = pickDiverseModels(googleModels.filter(m => isUltraModel(m.slug, m.name)), 1);
        selectedModels = [...sTop, ...aOpus, ...oTerra, ...gCarbon];
      } else {
        const sTop = sonarModels.slice(0, 1);
        const aSonnet = pickDiverseModels(anthropicModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        const oSol = pickDiverseModels(openAIModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        const gPro = pickDiverseModels(googleModels.filter(m => isFlagshipModel(m.slug, m.name) && !isUltraModel(m.slug, m.name)), 1);
        selectedModels = [...sTop, ...aSonnet, ...oSol, ...gPro];
      }
    }

    // --- 10. ALIBABA (Qwen) ---
    else if (provKey === 'alibaba') {
      if (planName.includes('free')) {
        selectedModels = pickDiverseModels(alibabaModels.filter(m => isLightweightModel(m.slug, m.name)), 3);
      } else {
        selectedModels = pickDiverseModels(alibabaModels, 4);
      }
    }

    // --- 11. COHERE ---
    else if (provKey === 'cohere') {
      selectedModels = pickDiverseModels(cohereModels, 4);
    }

    // Apply the newly resolved models if matches were found
    if (selectedModels.length > 0) {
      // Filter out discontinued models and sort latest-first
      const activeSelected = selectedModels.filter(m => !isDiscontinuedModel(m.name, m.slug));
      activeSelected.sort((a, b) => {
        const scoreA = getModelRecencyScore(a.name, a.slug, a.release_date);
        const scoreB = getModelRecencyScore(b.name, b.slug, b.release_date);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (b.rating || b.arena_elo || 0) - (a.rating || a.arena_elo || 0);
      });

      const modelSlugs = activeSelected.map(m => m.modelId || `${normalizeProvider(m.organization || provKey)}/${m.slug}`);
      const rawNames = activeSelected.map(m => m.name || m.slug);

      totalUpdated++;
      return {
        ...tier,
        models: Array.from(new Set(modelSlugs)),
        rawModels: Array.from(new Set(rawNames)),
        last_synced_at: new Date().toISOString()
      };
    }

    // For any tier without custom dynamic rule (e.g. Media/Audio tools), clean up discontinued and sort latest-first
    const filteredRaw = (tier.rawModels || []).filter(m => !isDiscontinuedModel(m));
    filteredRaw.sort((a, b) => getModelRecencyScore(b) - getModelRecencyScore(a));
    const filteredSlugs = (tier.models || []).filter(m => !isDiscontinuedModel(m));
    filteredSlugs.sort((a, b) => getModelRecencyScore(b) - getModelRecencyScore(a));

    return {
      ...tier,
      rawModels: filteredRaw,
      models: filteredSlugs,
      last_synced_at: tier.last_synced_at || new Date().toISOString()
    };
  });

  // Save the synchronized subscription tiers
  await saveSubscriptionTiers(updatedTiers);

  console.log(`✅ Subscription Tier Sync: Successfully refreshed ${updatedTiers.length} tiers (${totalUpdated} providers updated with top live models).`);
  return updatedTiers;
}

module.exports = { 
  syncSubscriptionTiers,
  isDiscontinuedModel,
  getModelRecencyScore,
  initDateMap,
  isLightweightModel,
  isUltraModel,
  isFlagshipModel,
  pickDiverseModels,
  extractAllModels,
  normalizeProvider
};
