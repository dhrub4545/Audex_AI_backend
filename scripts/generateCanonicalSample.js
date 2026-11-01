const fs = require('fs');
const path = require('path');

const tiers = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/subscription_tiers.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/raw_data.json'), 'utf8'));

// Build allModels with clean developer/creator prefixes
const sources = raw.sources || {};
const llms = Array.isArray(sources.llms) ? sources.llms : (sources.llms?.data || []);
const allModels = llms.map(item => {
  const inputCost = parseFloat(item.pricing?.price_1m_input_tokens || 0);
  const outputCost = parseFloat(item.pricing?.price_1m_output_tokens || 0);
  const evaluations = item.evaluations || {};
  const creatorName = item.model_creator?.name || item.organization || 'Unknown';
  let creatorSlug = (item.model_creator?.slug || creatorName).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!creatorSlug || creatorSlug === 'unknown') {
    const n = (item.name || '').toLowerCase();
    if (n.includes('gpt') || n.includes('openai')) creatorSlug = 'openai';
    else if (n.includes('claude') || n.includes('anthropic')) creatorSlug = 'anthropic';
    else if (n.includes('gemini') || n.includes('google')) creatorSlug = 'google';
    else if (n.includes('deepseek')) creatorSlug = 'deepseek';
    else if (n.includes('mistral') || n.includes('pixtral')) creatorSlug = 'mistralai';
    else if (n.includes('llama') || n.includes('meta')) creatorSlug = 'meta';
    else creatorSlug = 'ai';
  }
  const cleanSlug = (item.slug || '').toLowerCase().trim();
  const modelId = cleanSlug.includes('/') ? cleanSlug : (creatorSlug + '/' + cleanSlug);
  return {
    _id: item.modelId || modelId,
    slug: item.slug,
    name: item.name,
    developer: creatorName,
    context_length: item.context_length || 128000,
    endpoints: [{
      input_cost_per_m: inputCost,
      output_cost_per_m: outputCost,
      cache_read_cost_per_m: 0
    }],
    evaluations: evaluations,
    capabilities: {
      aa_index_score: parseFloat(evaluations.artificial_analysis_intelligence_index) || 50,
      coding_score: parseFloat(evaluations.artificial_analysis_coding_index) || 50,
      reasoning_score: parseFloat(evaluations.gpqa) || 50,
      math_score: parseFloat(evaluations.artificial_analysis_math_index) || 50,
      tokens_per_second: parseFloat(item.median_output_tokens_per_second) || 50,
      time_to_first_token_ms: item.median_time_to_first_token_seconds ? Math.round(item.median_time_to_first_token_seconds * 1000) : 500
    }
  };
});

function findSubscriptionTier(toolName, plan) {
  if (!tiers || tiers.length === 0) return null;
  const tn = (toolName || '').toLowerCase().trim();
  const pl = (plan || '').toLowerCase().trim();
  let providerTiers = tiers.filter(t => t.provider.toLowerCase() === tn || tn.includes(t.provider.toLowerCase()) || t.provider.toLowerCase().includes(tn));
  let match = providerTiers.find(t => t.plan.toLowerCase() === pl || pl.includes(t.plan.toLowerCase()) || t.plan.toLowerCase().includes(pl));
  if (!match && (pl.includes('advanced') || pl.includes('gemini'))) {
    match = providerTiers.find(t => t.plan.toLowerCase().includes('plus') || t.plan.toLowerCase().includes('pro'));
  }
  if (!match && pl.includes('one')) {
    match = providerTiers.find(t => t.plan.toLowerCase().includes('one'));
  }
  return match || providerTiers[0] || null;
}

function getSubscriptionPrice(toolName, plan) {
  const tier = findSubscriptionTier(toolName, plan);
  return tier ? tier.monthlyPrice : 0;
}

function getCategoryRankData(purpose) {
  const cat = (purpose || 'overall').toLowerCase();
  const filename = {
    'coding': 'coding.json',
    'writing': 'writing.json',
    'math': 'math.json',
    'research': 'research.json',
    'mixed': 'overall.json'
  }[cat] || 'overall.json';
  const catKey = filename.replace('.json', '');
  if (raw.categories && raw.categories[catKey]) {
    return raw.categories[catKey];
  }
  return raw.categories?.overall || [];
}

function findRankEntry(rankData, baselineSlug, baselineModelId, baselineName) {
  if (!rankData || rankData.length === 0) return null;
  const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetClean = clean(baselineSlug);
  const modelIdClean = clean(baselineModelId);
  const nameClean = clean(baselineName);

  if (baselineModelId) {
    let match = rankData.find(item => item.modelId && (item.modelId.toLowerCase() === baselineModelId.toLowerCase() || clean(item.modelId) === modelIdClean));
    if (match) return match;
  }
  if (baselineName) {
    let match = rankData.find(item => item.name && (item.name.toLowerCase() === baselineName.toLowerCase() || clean(item.name) === nameClean));
    if (match) return match;
  }
  if (baselineSlug) {
    let match = rankData.find(item => item.slug === baselineSlug);
    if (match) return match;
    match = rankData.find(item => clean(item.slug || '') === targetClean);
    if (match) return match;
    match = rankData.find(item => {
      const itemClean = clean(item.slug || '');
      return (itemClean && targetClean) && (itemClean.includes(targetClean) || targetClean.includes(itemClean));
    });
    if (match) return match;
  }
  if (nameClean && nameClean.length >= 4) {
    let match = rankData.find(item => {
      const itemClean = clean(item.name || '');
      return (itemClean && nameClean) && (itemClean.includes(nameClean) || nameClean.includes(itemClean));
    });
    if (match) return match;
  }
  return null;
}

function getEvaluationScore(item, purpose, dbModel, capabilityField) {
  if (!item && !dbModel) return 50;

  const evals = item?.evaluations || dbModel?.evaluations || {};
  const p = purpose ? purpose.toLowerCase() : 'mixed';

  // 1. Direct verified category benchmark (0-100) if available
  if (p === 'coding') {
    if (typeof evals.livecodebench === 'number' && evals.livecodebench > 0) {
      return Math.min(99, Math.round((evals.livecodebench / 90) * 100));
    }
    if (typeof evals.artificial_analysis_coding_index === 'number' && evals.artificial_analysis_coding_index > 0) {
      const v = evals.artificial_analysis_coding_index;
      return Math.min(99, Math.round(v <= 1 ? v * 100 : (v <= 60 ? (v / 60) * 100 : v)));
    }
    if (typeof evals.scicode === 'number' && evals.scicode > 0) {
      return Math.min(99, Math.round((evals.scicode / 67) * 98));
    }
  }

  if (p === 'math') {
    if (typeof evals.aime === 'number' && evals.aime > 0) {
      return Math.min(99, Math.round(evals.aime));
    }
    if (typeof evals.artificial_analysis_math_index === 'number' && evals.artificial_analysis_math_index > 0) {
      return Math.min(99, Math.round((evals.artificial_analysis_math_index / 67) * 98));
    }
  }

  if (p === 'reasoning') {
    if (typeof evals.gpqa === 'number' && evals.gpqa > 0) {
      return Math.min(99, Math.round(evals.gpqa));
    }
    if (typeof evals.artificial_analysis_intelligence_index === 'number' && evals.artificial_analysis_intelligence_index > 0) {
      return Math.min(99, Math.round((evals.artificial_analysis_intelligence_index / 60) * 100));
    }
  }

  if (p === 'research') {
    if (typeof evals.hle === 'number' && evals.hle > 0) {
      return Math.min(99, Math.round((evals.hle / 58) * 98));
    }
    if (typeof evals.gpqa === 'number' && evals.gpqa > 0) {
      return Math.min(99, Math.round(evals.gpqa));
    }
  }

  // 2. Direct overall intelligence index
  if (typeof evals.artificial_analysis_intelligence_index === 'number' && evals.artificial_analysis_intelligence_index > 0) {
    const v = evals.artificial_analysis_intelligence_index;
    return Math.min(99, Math.round(v <= 1 ? v * 100 : (v <= 60 ? (v / 60) * 100 : v)));
  }

  // 3. Composite of verified benchmark evaluations (GPQA, Math, MMLU-Pro, IFBench, LiveCodeBench, HLE)
  const parts = [];
  if (typeof evals.gpqa === 'number' && evals.gpqa > 0) parts.push(evals.gpqa);
  if (typeof evals.mmlu_pro === 'number' && evals.mmlu_pro > 0) parts.push(evals.mmlu_pro);
  if (typeof evals.artificial_analysis_math_index === 'number' && evals.artificial_analysis_math_index > 0) parts.push((evals.artificial_analysis_math_index / 67) * 98);
  if (typeof evals.livecodebench === 'number' && evals.livecodebench > 0) parts.push((evals.livecodebench / 90) * 100);
  if (typeof evals.ifbench === 'number' && evals.ifbench > 0) parts.push((evals.ifbench / 85) * 100);
  if (typeof evals.hle === 'number' && evals.hle > 0) parts.push((evals.hle / 58) * 98);

  if (parts.length > 0) {
    const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
    return Math.min(99, Math.max(25, Math.round(avg)));
  }

  // 4. Database capability score
  const dbScore = dbModel?.capabilities?.[capabilityField];
  if (typeof dbScore === 'number' && dbScore > 0) {
    return Math.min(100, Math.round(dbScore));
  }

  // 5. Rank-based capability scoring derived from live Artificial Analysis Category Rankings
  if (item && typeof item.rank === 'number' && item.rank > 0) {
    const rank = item.rank;
    let score;
    if (rank === 1) score = 99;
    else if (rank <= 3) score = 98;
    else if (rank <= 5) score = 97;
    else if (rank <= 10) score = 95 - (rank - 6);
    else if (rank <= 25) score = 90 - Math.round(((rank - 11) / 14) * 5);
    else if (rank <= 50) score = 84 - Math.round(((rank - 26) / 24) * 4);
    else if (rank <= 100) score = 79 - Math.round(((rank - 51) / 49) * 9);
    else if (rank <= 250) score = 69 - Math.round(((rank - 101) / 149) * 9);
    else if (rank <= 500) score = 59 - Math.round(((rank - 251) / 249) * 9);
    else score = Math.max(25, 49 - Math.round(((rank - 501) / 218) * 24));
    return score;
  }

  return 50;
}

function findTopModelOfSubscription(tier, rankData, allModels) {
  if (!tier) return null;
  const models = tier.models || [];
  const rawModels = tier.rawModels || [];
  let bestEntry = null;
  let bestModel = null;
  let bestScore = 0;
  let bestRank = 99999;

  for (const mid of models) {
    const slug = mid.includes('/') ? mid.split('/')[1] : mid;
    const entry = findRankEntry(rankData, slug, mid);
    const dbModel = allModels?.find(m => m._id === mid || (m._id && m._id.toLowerCase() === mid.toLowerCase()) || (m._id && m._id.split('/')[1] === slug));
    const score = getEvaluationScore(entry, 'mixed', dbModel, 'aa_index_score');
    const rank = entry ? (parseInt(entry.rank) || 9999) : 9999;
    if (score > bestScore || (score === bestScore && rank < bestRank)) {
      bestScore = score;
      bestRank = rank;
      bestEntry = entry;
      bestModel = dbModel || (entry ? {
        _id: entry.modelId || mid,
        name: entry.name,
        developer: entry.organization || tier.provider,
        endpoints: entry.pricing ? [{
          input_cost_per_m: entry.pricing.price_1m_input_tokens,
          output_cost_per_m: entry.pricing.price_1m_output_tokens
        }] : []
      } : dbModel);
    }
  }

  if (rawModels.length > 0) {
    for (const rm of rawModels) {
      const entry = rankData?.find(m => m.name && (m.name.toLowerCase().includes(rm.toLowerCase()) || rm.toLowerCase().includes(m.name.toLowerCase())));
      if (entry) {
        const dbModel = allModels?.find(m => m.name && m.name.toLowerCase() === entry.name.toLowerCase());
        const score = getEvaluationScore(entry, 'mixed', dbModel, 'aa_index_score');
        const rank = parseInt(entry.rank) || 9999;
        if (score > bestScore || (score === bestScore && rank < bestRank)) {
          bestScore = score;
          bestRank = rank;
          bestEntry = entry;
          bestModel = dbModel || {
            _id: entry.modelId || ('unknown/' + entry.slug),
            name: entry.name,
            developer: entry.organization || tier.provider
          };
        }
      }
    }
  }

  return { rank: bestRank, rankEntry: bestEntry, model: bestModel, score: bestScore };
}

function calculateModelCost(model, tokens, ratio) {
  const endpoint = model?.endpoints?.[0];
  const inPrice = endpoint?.input_cost_per_m ?? model?.pricing?.price_1m_input_tokens ?? 0;
  const outPrice = endpoint?.output_cost_per_m ?? model?.pricing?.price_1m_output_tokens ?? 0;
  const inputTokens = tokens * ratio;
  const outputTokens = tokens * (1 - ratio);
  return (inputTokens / 1000000 * inPrice) + (outputTokens / 1000000 * outPrice);
}

function getCleanProviderName(providerId) {
  if (!providerId) return '';
  const p = providerId.toLowerCase();
  if (p.includes('openai') || p.includes('chatgpt')) return 'OpenAI';
  if (p.includes('anthropic') || p.includes('claude')) return 'Anthropic';
  if (p.includes('google') || p.includes('gemini')) return 'Google';
  if (p.includes('github') || p.includes('copilot')) return 'GitHub';
  if (p.includes('perplexity')) return 'Perplexity';
  if (p.includes('xai') || p.includes('grok')) return 'xAI';
  if (p.includes('cursor')) return 'Cursor';
  if (p.includes('windsurf') || p.includes('codeium')) return 'Windsurf';
  if (p.includes('mistral')) return 'Mistral';
  if (p.includes('meta')) return 'Meta';
  if (p.includes('deepseek')) return 'DeepSeek';
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

function formatSubscriptionPlanName(provider = '', plan = '') {
  const p = (provider || '').toLowerCase();
  const pl = (plan || '').trim();
  if (p.includes('google') || p.includes('gemini')) {
    if (pl.toLowerCase().startsWith('gemini')) return pl;
    return `Gemini ${pl}`;
  }
  if (p.includes('openai') || p.includes('chatgpt')) {
    if (pl.toLowerCase().startsWith('chatgpt')) return pl;
    return `ChatGPT ${pl}`;
  }
  if (p.includes('anthropic') || p.includes('claude')) {
    if (pl.toLowerCase().startsWith('claude')) return pl;
    return `Claude ${pl}`;
  }
  if (p.includes('github') || p.includes('copilot')) {
    if (pl.toLowerCase().startsWith('github') || pl.toLowerCase().startsWith('copilot')) return pl;
    return `GitHub Copilot ${pl}`;
  }
  if (p.includes('cursor')) {
    if (pl.toLowerCase().startsWith('cursor')) return pl;
    return `Cursor ${pl}`;
  }
  if (p.includes('windsurf')) {
    if (pl.toLowerCase().startsWith('windsurf')) return pl;
    return `Windsurf ${pl}`;
  }
  if (p.includes('xai') || p.includes('grok')) {
    if (pl.toLowerCase().startsWith('grok') || pl.toLowerCase().startsWith('supergrok') || pl.toLowerCase().startsWith('x ')) return pl;
    return `Grok ${pl}`;
  }
  if (p.includes('perplexity')) {
    if (pl.toLowerCase().startsWith('perplexity')) return pl;
    return `Perplexity ${pl}`;
  }
  if (pl.toLowerCase().startsWith(p)) {
    return pl;
  }
  return `${provider} ${pl}`;
}

// 7 Canonical enterprise allocations
const inputAllocations = [
  {
    type: 'subscription',
    toolName: 'OpenAI',
    plan: 'ChatGPT Plus',
    seats: 1,
    purpose: 'Mixed'
  },
  {
    type: 'subscription',
    toolName: 'Anthropic',
    plan: 'Claude Pro',
    seats: 5,
    purpose: 'Mixed'
  },
  {
    type: 'subscription',
    toolName: 'Google',
    plan: 'AI Plus',
    seats: 1,
    purpose: 'Mixed'
  },
  {
    type: 'api',
    toolName: 'Anthropic: Claude Fable 5',
    seats: 1,
    purpose: 'Coding',
    modelId: 'anthropic/claude-fable-5',
    inputTokens: 10000000,
    outputTokens: 2500000
  },
  {
    type: 'subscription',
    toolName: 'Mistral',
    plan: 'Le Chat Pro',
    seats: 2,
    purpose: 'Coding'
  },
  {
    type: 'subscription',
    toolName: 'Meta',
    plan: 'Meta One Plus',
    seats: 1,
    purpose: 'Research'
  },
  {
    type: 'subscription',
    toolName: 'DeepSeek',
    plan: 'Consumer',
    seats: 1,
    purpose: 'Mixed'
  }
];

const optimizationGoal = 'performance';
const costCutPercentage = 50;

// Execute audit engine logic
const parsedAllocations = [];
const allocationDetails = [];
let totalCurrentBudget = 0;

inputAllocations.forEach((alloc, allocIndex) => {
  const type = alloc.type || 'subscription';
  const toolName = alloc.toolName;
  const purpose = alloc.purpose || 'Mixed';
  const seats = parseInt(alloc.seats) || 1;

  const capabilityField = {
    'Coding': 'coding_score',
    'Writing': 'reasoning_score',
    'Math': 'math_score',
    'Research': 'reasoning_score',
    'Mixed': 'aa_index_score'
  }[purpose] || 'aa_index_score';

  let currentCost = 0;
  let baselineScore = 0;
  let primaryBaselineModel = null;
  let baselineModelIds = [];
  let tier = null;
  let isMedia = false;
  let plan = '';
  let pricePerSeat = 0;
  let modelId = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let inputRatio = 0.8;

  if (type === 'subscription') {
    plan = alloc.plan || 'Free';
    pricePerSeat = getSubscriptionPrice(toolName, plan);
    currentCost = seats * pricePerSeat;

    parsedAllocations.push({
      _id: `alloc_${allocIndex}`,
      type,
      toolName,
      plan,
      seats,
      purpose,
      pricePerSeat,
      currentCost
    });

    tier = findSubscriptionTier(toolName, plan);
    const category = tier ? tier.category : 'Chat & Reasoning';
    isMedia = ['media (image)', 'media (video)', 'media (audio)', 'ui & layouts'].includes(category.toLowerCase());

    const rankData = getCategoryRankData(purpose);
    const topSub = findTopModelOfSubscription(tier, rankData, allModels);

    if (topSub && topSub.model) {
      primaryBaselineModel = topSub.model;
      baselineScore = topSub.score;
    }

    const promptTokensPerSeat = purpose === 'Coding' ? 10000000 : 5000000;
    const completionTokensPerSeat = purpose === 'Coding' ? 2500000 : 1250000;
    const totalPromptTokens = seats * promptTokensPerSeat;
    const totalCompletionTokens = seats * completionTokensPerSeat;
    totalTokens = totalPromptTokens + totalCompletionTokens;
    inputRatio = totalTokens > 0 ? (totalPromptTokens / totalTokens) : 0.8;
  } else if (type === 'api') {
    modelId = alloc.modelId;
    inputTokens = parseFloat(alloc.inputTokens) || 10000000;
    outputTokens = parseFloat(alloc.outputTokens) || 2500000;
    totalTokens = inputTokens + outputTokens;
    inputRatio = totalTokens > 0 ? (inputTokens / totalTokens) : 0.8;

    let currentModel = allModels.find(m => m._id === modelId);
    if (!currentModel && allModels.length > 0) {
      const targetBase = (modelId.split('/')[1] || modelId).toLowerCase();
      currentModel = allModels.find(m => m._id.toLowerCase().includes(targetBase));
    }

    if (currentModel) {
      primaryBaselineModel = currentModel;
      currentCost = calculateModelCost(currentModel, totalTokens, inputRatio);
      const rankData = getCategoryRankData(purpose);
      const currentSlug = currentModel._id.split('/')[1] || '';
      const currentRankEntry = findRankEntry(rankData, currentSlug, currentModel._id, currentModel.name);
      baselineScore = currentRankEntry ? getEvaluationScore(currentRankEntry, purpose, currentModel, capabilityField) : (currentModel.capabilities?.[capabilityField] || 0);
    }

    parsedAllocations.push({
      _id: `alloc_${allocIndex}`,
      type,
      toolName,
      seats,
      purpose,
      currentCost,
      modelId,
      inputTokens,
      outputTokens
    });
  }

  totalCurrentBudget += currentCost;

  allocationDetails.push({
    allocIndex,
    type,
    toolName,
    purpose,
    seats,
    plan,
    modelId,
    currentCost,
    baselineScore,
    primaryBaselineModel,
    baselineModelIds,
    tier,
    isMedia,
    inputTokens,
    outputTokens,
    totalTokens,
    inputRatio,
    capabilityField
  });
});

// Update parsedAllocations metadata
allocationDetails.forEach((detail, i) => {
  if (parsedAllocations[i]) {
    parsedAllocations[i].currentCost = detail.currentCost;
    parsedAllocations[i].topModelId = detail.primaryBaselineModel ? detail.primaryBaselineModel._id : null;
    parsedAllocations[i].topModelName = detail.primaryBaselineModel ? detail.primaryBaselineModel.name : null;
    parsedAllocations[i].baselineModelId = detail.primaryBaselineModel ? detail.primaryBaselineModel._id : null;
    parsedAllocations[i].baselineModelName = detail.primaryBaselineModel ? detail.primaryBaselineModel.name : null;
    parsedAllocations[i].baselineModels = detail.tier ? (detail.tier.rawModels || []) : [];
  }
});

let apiMonthlySavings = 0;
let subMonthlySavings = 0;
const recommendations = [];

allocationDetails.forEach((detail, idx) => {
  let {
    allocIndex,
    type,
    toolName,
    purpose,
    seats,
    plan,
    modelId,
    currentCost,
    baselineScore,
    primaryBaselineModel,
    tier,
    isMedia,
    inputTokens,
    outputTokens,
    totalTokens,
    inputRatio,
    capabilityField
  } = detail;

  const rankData = getCategoryRankData(purpose);

  const currentModel = (type === 'api' && modelId)
    ? (allModels.find(m => m._id === modelId) ||
       allModels.find(m => m._id && m._id.toLowerCase().includes(modelId.toLowerCase())))
    : null;

  let baselineRank = 9999;
  let computedBaselineScore = baselineScore;

  if (type === 'subscription') {
    const matchingTier = findSubscriptionTier(toolName, plan);
    const topSub = findTopModelOfSubscription(matchingTier, rankData, allModels);
    if (topSub && topSub.rankEntry) {
      baselineRank = topSub.rank;
      computedBaselineScore = topSub.score;
      if (topSub.model) {
        primaryBaselineModel = topSub.model;
      }
    }
  } else {
    if (currentModel) {
      const currentSlug = currentModel._id.split('/')[1] || '';
      const rankEntry = findRankEntry(rankData, currentSlug, currentModel._id, currentModel.name);
      if (rankEntry) {
        baselineRank = parseInt(rankEntry.rank) || 999;
        computedBaselineScore = getEvaluationScore(rankEntry, purpose, currentModel, capabilityField);
      } else {
        computedBaselineScore = currentModel.capabilities?.[capabilityField] || 0;
      }
    }
  }

  if (baselineRank === 9999) {
    baselineRank = 500;
  }

  // API Candidates
  let apiCandidates = [];
  if (rankData.length > 0) {
    for (const item of rankData) {
      if (!item.slug && !item.modelId) continue;
      let dbModel = null;
      if (item.modelId) {
        dbModel = allModels.find(m => m._id === item.modelId || m._id.toLowerCase() === item.modelId.toLowerCase());
      }
      if (!dbModel && item.slug) {
        const cleanSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const itemClean = cleanSlug(item.slug);
        dbModel = allModels.find(m => cleanSlug(m._id.split('/')[1] || '') === itemClean);
      }
      if (!dbModel && item.name) {
        const cleanSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const itemCleanName = cleanSlug(item.name);
        dbModel = allModels.find(m => cleanSlug(m.name || '') === itemCleanName);
      }

      const inP = item.pricing?.price_1m_input_tokens || dbModel?.endpoints?.[0]?.input_cost_per_m || 0;
      const outP = item.pricing?.price_1m_output_tokens || dbModel?.endpoints?.[0]?.output_cost_per_m || 0;
      if (inP <= 0 || outP <= 0) continue;

      const candidateId = dbModel?._id || item.modelId || `unknown/${item.slug}`;
      if (apiCandidates.some(c => c._id === candidateId)) continue;

      const cost = (totalTokens * inputRatio / 1000000 * inP) + (totalTokens * (1 - inputRatio) / 1000000 * outP);
      const score = getEvaluationScore(item, purpose, dbModel, capabilityField);
      const contextLength = dbModel?.context_length || 128000;
      const contextStr = contextLength >= 1000000 ? `${(contextLength / 1000000).toFixed(0)}M` : `${(contextLength / 1000).toFixed(0)}K`;
      const limitsStr = `Pay-as-you-go rates: $${inP.toFixed(2)}/1M input, $${outP.toFixed(2)}/1M output. Context: ${contextStr}.`;

      apiCandidates.push({
        _id: candidateId,
        name: item.name || dbModel?.name,
        rank: parseInt(item.rank) || 999,
        performance_score: score,
        monthly_cost: cost,
        isCurrent: (candidateId === modelId) || (dbModel && dbModel._id === modelId),
        limits: limitsStr,
        context_length: contextLength,
        inputCostPerM: inP,
        outputCostPerM: outP
      });
    }
  }

  let selectedApi = null;
  let apiStatusText = "";

  if (optimizationGoal === 'performance') {
    // Performance Preservation: Must preserve or improve capability (>= 95% retention) AND have lower cost
    let compatible = apiCandidates.filter(c => {
      if (c.isCurrent) return false;
      if (c.monthly_cost >= currentCost) return false;
      if (computedBaselineScore > 0 && c.performance_score < Math.round(computedBaselineScore * 0.95)) return false;
      if (baselineRank !== 9999 && c.rank > baselineRank && c.performance_score < computedBaselineScore) return false;
      return true;
    });
    compatible.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank) || (a.monthly_cost - b.monthly_cost));
    selectedApi = compatible[0] || null;
    if (!selectedApi) {
      apiStatusText = "Already optimized in this category.";
    }
  }

  // Subscription Candidates
  let subCandidates = [];
  const allowedCategories = [];
  if (isMedia) {
    const origTier = findSubscriptionTier(toolName, plan);
    const cat = origTier ? origTier.category.toLowerCase() : 'chat & reasoning';
    allowedCategories.push(cat);
  } else {
    if (purpose === 'Coding') {
      allowedCategories.push('chat & reasoning', 'code assistant');
    } else {
      allowedCategories.push('chat & reasoning');
    }
  }

  const filteredTiers = tiers.filter(t => allowedCategories.includes(t.category.toLowerCase()));
  const isCurrentPlanFree = type === 'subscription' && (plan.toLowerCase() === 'free' || currentCost === 0);

  filteredTiers.forEach(t => {
    if (!isCurrentPlanFree && (t.plan.toLowerCase() === 'free' || t.monthlyPrice === 0)) return;
    const cost = seats * t.monthlyPrice;
    const topSub = findTopModelOfSubscription(t, rankData, allModels);
    const bestRank = topSub ? topSub.rank : 999;
    const bestScore = topSub ? topSub.score : 50;

    const isCurrent = type === 'subscription' && 
                      (t.provider.toLowerCase() === toolName.toLowerCase() || toolName.toLowerCase().includes(t.provider.toLowerCase())) &&
                      t.plan.toLowerCase() === plan.toLowerCase();

    subCandidates.push({
      tier: t,
      topModel: topSub?.model,
      cost,
      rank: bestRank,
      performance_score: bestScore,
      isCurrent
    });
  });

  let selectedSub = null;
  let subStatusText = "";

  if (optimizationGoal === 'performance') {
    // Performance Preservation: Must preserve or improve capability (>= 95% retention) AND have lower cost
    // Require at least $1.00/mo savings to avoid migrating for pennies
    let compatible = subCandidates.filter(c => {
      if (c.isCurrent) return false;
      if (c.cost >= (currentCost - 1.00)) return false;
      if (computedBaselineScore > 0 && c.performance_score < Math.round(computedBaselineScore * 0.95)) return false;
      if (baselineRank !== 9999 && c.rank > baselineRank && c.performance_score < computedBaselineScore) return false;
      return true;
    });
    compatible.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank) || (a.cost - b.cost));
    selectedSub = compatible[0] || null;
    if (!selectedSub) {
      subStatusText = "Already optimized in this category.";
    }
  }

  // Build apiOption
  const apiOption = selectedApi ? {
    _id: `rec_api_${idx}`,
    cost: parseFloat(selectedApi.monthly_cost.toFixed(2)),
    savings: parseFloat((currentCost - selectedApi.monthly_cost).toFixed(2)),
    name: selectedApi.name,
    modelId: selectedApi._id,
    performance_score: selectedApi.performance_score,
    category_rank: selectedApi.rank,
    action: `Transition active users to direct API keys using ${selectedApi.name}.`,
    statusText: "",
    isAlreadyOptimized: false,
    limits: selectedApi.limits,
    includedModels: [selectedApi.name],
    recommendedModel: selectedApi.name,
    recommendedProvider: getCleanProviderName(selectedApi._id.split('/')[0]),
    inputCostPerM: selectedApi.inputCostPerM,
    outputCostPerM: selectedApi.outputCostPerM,
    defaultInputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 10000000 : 5000000)) : inputTokens,
    defaultOutputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 2500000 : 1250000)) : outputTokens
  } : {
    _id: `rec_api_${idx}`,
    cost: parseFloat(currentCost.toFixed(2)),
    savings: 0,
    name: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model"),
    modelId: primaryBaselineModel ? primaryBaselineModel._id : modelId,
    performance_score: computedBaselineScore,
    category_rank: baselineRank,
    action: (type === 'api')
      ? "Your current model API is already the best choice. Keep using it."
      : `Transition active users to direct API keys using ${primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model")}.`,
    statusText: (type === 'api') ? (apiStatusText || "Optimized") : "",
    isAlreadyOptimized: type === 'api' && !selectedApi,
    limits: primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints.length > 0
      ? `Pay-as-you-go rates: $${primaryBaselineModel.endpoints[0].input_cost_per_m.toFixed(2)}/1M input, $${primaryBaselineModel.endpoints[0].output_cost_per_m.toFixed(2)}/1M output.`
      : "Pay-as-you-go token consumption limits.",
    includedModels: primaryBaselineModel ? [primaryBaselineModel.name] : (modelId ? [modelId] : []),
    recommendedModel: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model"),
    recommendedProvider: primaryBaselineModel ? getCleanProviderName(primaryBaselineModel._id.split('/')[0]) : getCleanProviderName(toolName),
    inputCostPerM: (primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints[0]) ? (primaryBaselineModel.endpoints[0].input_cost_per_m || 0) : 0,
    outputCostPerM: (primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints[0]) ? (primaryBaselineModel.endpoints[0].output_cost_per_m || 0) : 0,
    defaultInputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 10000000 : 5000000)) : inputTokens,
    defaultOutputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 2500000 : 1250000)) : outputTokens
  };

  // Build subscriptionOption
  const recommendedSubTopModel = selectedSub?.topModel || (selectedSub?.tier ? findTopModelOfSubscription(selectedSub.tier, rankData, allModels)?.model : null);
  const subFormattedPlan = selectedSub?.tier ? formatSubscriptionPlanName(selectedSub.tier.provider, selectedSub.tier.plan) : '';
  const fallbackFormattedPlan = formatSubscriptionPlanName(toolName, plan || "Free");
  const subscriptionOption = selectedSub ? {
    _id: `rec_sub_${idx}`,
    planName: subFormattedPlan,
    cost: parseFloat(selectedSub.cost.toFixed(2)),
    savings: parseFloat((currentCost - selectedSub.cost).toFixed(2)),
    limits: selectedSub.tier.limits,
    includedModels: selectedSub.tier.rawModels || [],
    modelId: recommendedSubTopModel ? recommendedSubTopModel._id : (selectedSub.tier.models?.[0] || null),
    topModelId: recommendedSubTopModel ? recommendedSubTopModel._id : null,
    topModelName: recommendedSubTopModel ? recommendedSubTopModel.name : null,
    performance_score: selectedSub.performance_score,
    category_rank: selectedSub.rank,
    action: `Migrate to the ${subFormattedPlan} subscription.`,
    statusText: "",
    alreadyOptimized: false,
    recommendedModel: subFormattedPlan,
    recommendedProvider: getCleanProviderName(selectedSub.tier.provider)
  } : {
    _id: `rec_sub_${idx}`,
    planName: fallbackFormattedPlan,
    cost: parseFloat(currentCost.toFixed(2)),
    savings: 0,
    limits: tier ? tier.limits : "Free plan limits",
    includedModels: tier ? (tier.rawModels || []) : [],
    modelId: primaryBaselineModel ? primaryBaselineModel._id : (tier?.models?.[0] || null),
    topModelId: primaryBaselineModel ? primaryBaselineModel._id : null,
    topModelName: primaryBaselineModel ? primaryBaselineModel.name : null,
    performance_score: computedBaselineScore,
    category_rank: baselineRank,
    action: (type === 'subscription')
      ? "Your current subscription is already the best choice. Keep using it."
      : `Migrate to the ${fallbackFormattedPlan} subscription.`,
    statusText: (type === 'subscription') ? (subStatusText || "Optimized") : "",
    alreadyOptimized: type === 'subscription' && !selectedSub,
    recommendedModel: fallbackFormattedPlan,
    recommendedProvider: getCleanProviderName(toolName)
  };

  if (apiOption) {
    apiMonthlySavings += apiOption.savings;
  }
  if (subscriptionOption) {
    subMonthlySavings += subscriptionOption.savings;
  }

  const toolDesc = type === 'subscription' 
    ? `${toolName} (${plan} Subscription for ${seats} seat${seats > 1 ? 's' : ''})`
    : `${toolName} API (${modelId} for ${purpose})`;
  
  const issueDesc = type === 'subscription'
    ? `Paying $${currentCost.toFixed(2)}/mo for ${seats} active ${purpose} user${seats > 1 ? 's' : ''}`
    : `Paying $${currentCost.toFixed(2)}/mo for API usage (${((totalTokens)/1000000).toFixed(1)}M tokens)`;

  const currentProvider = getCleanProviderName(toolName);
  const currentModelName = primaryBaselineModel ? primaryBaselineModel.name : (modelId || (type === 'subscription' ? plan : 'GPT-4o'));

  recommendations.push({
    _id: `rec_${idx}`,
    tool: toolDesc,
    issue: issueDesc,
    action: "Select the most suitable option below.",
    purpose: purpose,
    baselineScore: computedBaselineScore,
    baselineRank: baselineRank,
    monthlySavings: Math.max(apiOption.savings, subscriptionOption.savings),
    isAlreadyOptimized: (apiOption.isAlreadyOptimized && subscriptionOption.isAlreadyOptimized) || (apiOption.savings === 0 && subscriptionOption.savings === 0),
    statusText: (apiOption.savings === 0 && subscriptionOption.savings === 0) ? "Optimized" : "",
    apiOption,
    subscriptionOption,
    originalAlloc: {
      type,
      toolName,
      plan,
      seats,
      purpose,
      currentCost: parseFloat(currentCost.toFixed(2)),
      modelId,
      provider: currentProvider,
      modelName: currentModelName,
      performance_score: computedBaselineScore,
      category_rank: baselineRank
    }
  });
});

const totalSeats = inputAllocations.reduce((acc, a) => acc + (parseInt(a.seats) || 1), 0);

const selectedOptions = {
  "0": "api",
  "1": "subscription",
  "2": "subscription",
  "3": "api",
  "4": "subscription",
  "5": "subscription",
  "6": "subscription"
};

let totalSelectedSavings = 0;
parsedAllocations.forEach((alloc, idx) => {
  const choice = selectedOptions[idx] || 'api';
  const opt = choice === 'api' ? recommendations[idx].apiOption : recommendations[idx].subscriptionOption;
  const currentCost = alloc.currentCost;
  const optCost = opt ? opt.cost : currentCost;
  totalSelectedSavings += Math.max(0, currentCost - optCost);
});

const totalAnnualSavings = totalSelectedSavings * 12;

const finalSampleAuditData = {
  _id: "sample_audit_2026",
  userId: "sample_enterprise_user",
  createdAt: "2026-07-21T23:13:00.000Z",
  teamSize: totalSeats,
  useCase: "Coding & Mixed Workloads",
  optimizationGoal,
  costCutPercentage,
  qualityThreshold: 90,
  isUnlocked: true,
  totalCurrentCost: parseFloat(totalCurrentBudget.toFixed(2)),
  tierUsed: "pro",
  selectedOptions,
  allocations: parsedAllocations,
  savings: {
    totalMonthly: parseFloat(totalSelectedSavings.toFixed(2)),
    totalAnnual: parseFloat(totalAnnualSavings.toFixed(2)),
    totalOptimizedSpend: parseFloat(Math.max(0, totalCurrentBudget - totalSelectedSavings).toFixed(2)),
    percentageSavings: parseFloat((totalCurrentBudget > 0 ? (totalSelectedSavings / totalCurrentBudget * 100) : 0).toFixed(1)),
    apiMonthly: parseFloat(apiMonthlySavings.toFixed(2)),
    apiAnnual: parseFloat((apiMonthlySavings * 12).toFixed(2)),
    subMonthly: parseFloat(subMonthlySavings.toFixed(2)),
    subAnnual: parseFloat((subMonthlySavings * 12).toFixed(2)),
    recommendations
  }
};

console.log('--- CORRECTED AUDIT CALCULATION RESULT ---');
console.log('Total Current Cost:', finalSampleAuditData.totalCurrentCost);
console.log('Total Monthly Savings:', finalSampleAuditData.savings.totalMonthly);
console.log('Percentage Savings:', finalSampleAuditData.savings.percentageSavings + '%');
console.log('\n--- RECOMMENDATIONS ---');
finalSampleAuditData.savings.recommendations.forEach((r, i) => {
  console.log(`[Alloc ${i}] ${r.tool}`);
  console.log(`   Selected Category: ${r.purpose}`);
  console.log(`   Baseline Model: ${r.originalAlloc.modelName} (Score: ${r.baselineScore}/100, Rank #${r.baselineRank})`);
  console.log(`   API Option: ${r.apiOption.name} ($${r.apiOption.cost}/mo, save $${r.apiOption.savings}/mo, Score: ${r.apiOption.performance_score}/100)`);
  console.log(`   Sub Option: ${r.subscriptionOption.planName} ($${r.subscriptionOption.cost}/mo, save $${r.subscriptionOption.savings}/mo, Model: ${r.subscriptionOption.topModelName || r.subscriptionOption.recommendedModel}, Score: ${r.subscriptionOption.performance_score}/100)`);
});

fs.writeFileSync(path.join(__dirname, 'output_sample_audit.json'), JSON.stringify(finalSampleAuditData, null, 2));

const targetFrontendPath = path.join(__dirname, '../../frontend/src/utils/sampleReportData.js');
const jsContent = `// Canonical Sample Audit Data - Generated from 100% Artificial Analysis benchmarks
export const SAMPLE_AUDIT_DATA = ${JSON.stringify(finalSampleAuditData, null, 2)};
`;
fs.writeFileSync(targetFrontendPath, jsContent, 'utf8');
console.log('\nSuccessfully updated frontend/src/utils/sampleReportData.js!');
console.log('\nSaved to output_sample_audit.json');
