const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

/**
 * Service to generate, cache, and serve the Canonical Sample Audit Report
 * dynamically updated daily with the latest benchmark models and pricing.
 */

function findSubscriptionTier(toolName, plan, tiers) {
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

function getSubscriptionPrice(toolName, plan, tiers) {
  const tier = findSubscriptionTier(toolName, plan, tiers);
  return tier ? tier.monthlyPrice : 0;
}

function getCategoryRankData(purpose, customRaw) {
  const cat = (purpose || 'overall').toLowerCase();
  const filename = {
    'coding': 'coding.json',
    'writing': 'writing.json',
    'math': 'math.json',
    'research': 'research.json',
    'mixed': 'overall.json'
  }[cat] || 'overall.json';

  const rankFilePath = path.join(__dirname, '../data/rank', filename);
  if (fs.existsSync(rankFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(rankFilePath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) {}
  }

  const catKey = filename.replace('.json', '');
  if (customRaw && customRaw.categories && customRaw.categories[catKey]) {
    return customRaw.categories[catKey];
  }
  return customRaw?.categories?.overall || [];
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
  if (!item && !dbModel) return null;

  const evals = item?.evaluations || dbModel?.evaluations || {};
  const p = purpose ? purpose.toLowerCase() : 'mixed';

  // 1. Direct verified category benchmark (actual raw values without normalization scaling)
  if (p === 'coding') {
    if (item?.category_scores && typeof item.category_scores.coding === 'number') {
      return Math.round(item.category_scores.coding);
    }
    if (typeof evals.artificial_analysis_coding_index === 'number') {
      return Math.round(evals.artificial_analysis_coding_index);
    }
    if (typeof evals.coding_agent_index === 'number') {
      return Math.round(evals.coding_agent_index);
    }
    if (typeof item?.final_score === 'number') {
      return Math.round(item.final_score);
    }
    if (typeof evals.livecodebench === 'number') {
      return Math.round(evals.livecodebench);
    }
  }

  if (p === 'math') {
    if (typeof evals.livebench_math === 'number') {
      return Math.round(evals.livebench_math);
    }
    if (item?.category_scores && typeof item.category_scores.math === 'number') {
      return Math.round(item.category_scores.math);
    }
    if (typeof item?.final_score === 'number' && item.final_score > 0) {
      return Math.round(item.final_score);
    }
    if (typeof evals.artificial_analysis_math_index === 'number') {
      return Math.round(evals.artificial_analysis_math_index);
    }
    if (typeof evals.aime === 'number') {
      return Math.round(evals.aime);
    }
  }

  if (p === 'reasoning') {
    if (item?.category_scores && typeof item.category_scores.reasoning === 'number') {
      return Math.round(item.category_scores.reasoning);
    }
    if (typeof evals.gpqa === 'number') {
      return Math.round(evals.gpqa);
    }
    if (typeof evals.hle_diamond === 'number') {
      return Math.round(evals.hle_diamond);
    }
    if (typeof evals.artificial_analysis_intelligence_index === 'number') {
      return Math.round(evals.artificial_analysis_intelligence_index);
    }
    if (typeof item?.final_score === 'number') {
      return Math.round(item.final_score);
    }
  }

  if (p === 'research') {
    if (item?.category_scores && typeof item.category_scores.research === 'number') {
      return Math.round(item.category_scores.research);
    }
    if (typeof evals.gpqa === 'number') {
      return Math.round(evals.gpqa);
    }
    if (typeof evals.hle === 'number') {
      return Math.round(evals.hle);
    }
    if (typeof item?.final_score === 'number') {
      return Math.round(item.final_score);
    }
  }

  if (p === 'writing') {
    if (item?.category_scores && typeof item.category_scores['creative-writing'] === 'number') {
      return Math.round(item.category_scores['creative-writing']);
    }
    if (item?.category_scores && typeof item.category_scores.writing === 'number') {
      return Math.round(item.category_scores.writing);
    }
    if (typeof item?.final_score === 'number') {
      return Math.round(item.final_score);
    }
  }

  // 2. Direct overall intelligence index
  if (item?.category_scores && typeof item.category_scores.overall === 'number') {
    return Math.round(item.category_scores.overall);
  }
  if (typeof evals.artificial_analysis_intelligence_index === 'number') {
    return Math.round(evals.artificial_analysis_intelligence_index);
  }
  if (typeof item?.final_score === 'number') {
    return Math.round(item.final_score);
  }

  // 3. Composite of verified benchmark evaluations (raw unscaled average)
  const parts = [];
  if (typeof evals.gpqa === 'number') parts.push(evals.gpqa);
  if (typeof evals.mmlu_pro === 'number') parts.push(evals.mmlu_pro);
  if (typeof evals.livebench_math === 'number') parts.push(evals.livebench_math);
  if (typeof evals.artificial_analysis_math_index === 'number') parts.push(evals.artificial_analysis_math_index);
  if (typeof evals.artificial_analysis_coding_index === 'number') parts.push(evals.artificial_analysis_coding_index);
  if (typeof evals.coding_agent_index === 'number') parts.push(evals.coding_agent_index);
  if (typeof evals.livecodebench === 'number') parts.push(evals.livecodebench);
  if (typeof evals.ifbench === 'number') parts.push(evals.ifbench);
  if (typeof evals.hle === 'number') parts.push(evals.hle);

  if (parts.length > 0) {
    const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
    return Math.round(avg);
  }

  // 4. Database capability score
  const dbScore = dbModel?.capabilities?.[capabilityField];
  if (typeof dbScore === 'number' && dbScore > 0) {
    return Math.round(dbScore);
  }

  // 5. Rank-based capability scoring derived from live rankings
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
    if (entry && entry.deprecated && bestModel) continue;
    const dbModel = allModels?.find(m => m._id === mid || (m._id && m._id.toLowerCase() === mid.toLowerCase()) || (m._id && m._id.split('/')[1] === slug));
    const score = getEvaluationScore(entry, 'mixed', dbModel, 'aa_index_score');
    const rank = entry ? (parseInt(entry.rank) || 9999) : 9999;
    if (score > bestScore || (score === bestScore && rank < bestRank) || (!bestModel && entry)) {
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
        if (entry.deprecated && bestModel) continue;
        const dbModel = allModels?.find(m => m.name && m.name.toLowerCase() === entry.name.toLowerCase());
        const score = getEvaluationScore(entry, 'mixed', dbModel, 'aa_index_score');
        const rank = parseInt(entry.rank) || 9999;
        if (score > bestScore || (score === bestScore && rank < bestRank) || (!bestModel && entry)) {
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

/**
 * Generates the canonical sample audit report based on the latest models and ranks.
 */
async function generateSampleReport(options = {}) {
  const isCli = options.log !== false;
  const tiersPath = path.join(__dirname, '../data/subscription_tiers.json');
  const rawPath = path.join(__dirname, '../data/raw_data.json');

  let tiers = [];
  let raw = {};

  try {
    if (fs.existsSync(tiersPath)) {
      tiers = JSON.parse(fs.readFileSync(tiersPath, 'utf8'));
    }
    if (fs.existsSync(rawPath)) {
      raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    }
  } catch (err) {
    if (isCli) console.warn('Warning reading data files for sample report:', err.message);
  }

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
        math_score: parseFloat(evaluations.livebench_math || evaluations.artificial_analysis_math_index) || 50,
        tokens_per_second: parseFloat(item.median_output_tokens_per_second) || 50,
        time_to_first_token_ms: item.median_time_to_first_token_seconds ? Math.round(item.median_time_to_first_token_seconds * 1000) : 500
      }
    };
  });

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
  const qualityThreshold = 90;

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
      pricePerSeat = getSubscriptionPrice(toolName, plan, tiers);
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

      tier = findSubscriptionTier(toolName, plan, tiers);
      const category = tier ? tier.category : 'Chat & Reasoning';
      isMedia = ['media (image)', 'media (video)', 'media (audio)', 'ui & layouts'].includes(category.toLowerCase());

      const rankData = getCategoryRankData(purpose, raw);
      const topSub = findTopModelOfSubscription(tier, rankData, allModels);

      if (topSub && topSub.model) {
        primaryBaselineModel = topSub.model;
        baselineScore = topSub.score;
      }

      const promptTokensPerSeat = purpose === 'Coding' ? 2500000 : 1250000;
      const completionTokensPerSeat = purpose === 'Coding' ? 625000 : 312500;
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
        const rankData = getCategoryRankData(purpose, raw);
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

    const rankData = getCategoryRankData(purpose, raw);

    const currentModel = (type === 'api' && modelId)
      ? (allModels.find(m => m._id === modelId) ||
         allModels.find(m => m._id && m._id.toLowerCase().includes(modelId.toLowerCase())))
      : null;

    let baselineRank = 9999;
    let computedBaselineScore = baselineScore;

    if (type === 'subscription') {
      const matchingTier = findSubscriptionTier(toolName, plan, tiers);
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
      let compatible = apiCandidates.filter(c => {
        if (c.isCurrent) return false;
        if (currentCost > 0 && c.monthly_cost >= currentCost) return false;
        if (computedBaselineScore > 0 && c.performance_score < Math.round(computedBaselineScore * 0.90)) return false;
        return true;
      });
      compatible.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank) || (a.monthly_cost - b.monthly_cost));
      selectedApi = compatible[0] || null;

      if (!selectedApi) {
        // High quality cost saving candidate
        let costSaving = apiCandidates.filter(c => !c.isCurrent && (currentCost === 0 || c.monthly_cost < currentCost) && c.performance_score >= (qualityThreshold || 80));
        costSaving.sort((a, b) => (b.performance_score - a.performance_score) || (a.monthly_cost - b.monthly_cost));
        selectedApi = costSaving[0] || null;
      }
      if (!selectedApi) {
        // Frontier upgrade candidate from leaderboard with superior score
        let frontier = apiCandidates.filter(c => !c.isCurrent && c.performance_score >= computedBaselineScore);
        frontier.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank) || (a.monthly_cost - b.monthly_cost));
        selectedApi = frontier[0] || null;
      }
      if (!selectedApi) {
        // Best general non-current candidate
        let general = apiCandidates.filter(c => !c.isCurrent);
        general.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank));
        selectedApi = general[0] || null;
      }
    }

    // Subscription Candidates
    let subCandidates = [];
    const allowedCategories = [];
    if (isMedia) {
      const origTier = findSubscriptionTier(toolName, plan, tiers);
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
      let compatible = subCandidates.filter(c => {
        if (c.isCurrent) return false;
        if (currentCost > 0 && c.cost >= currentCost) return false;
        if (computedBaselineScore > 0 && c.performance_score < Math.round(computedBaselineScore * 0.90)) return false;
        return true;
      });
      compatible.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank) || (a.cost - b.cost));
      selectedSub = compatible[0] || null;

      if (!selectedSub) {
        let costSaving = subCandidates.filter(c => !c.isCurrent && (currentCost === 0 || c.cost < currentCost) && c.performance_score >= 75);
        costSaving.sort((a, b) => (b.performance_score - a.performance_score) || (a.cost - b.cost));
        selectedSub = costSaving[0] || null;
      }
      if (!selectedSub) {
        let frontier = subCandidates.filter(c => !c.isCurrent && (currentCost === 0 ? c.cost <= 15 : c.cost <= currentCost));
        frontier.sort((a, b) => (b.performance_score - a.performance_score) || (a.rank - b.rank) || (a.cost - b.cost));
        selectedSub = frontier[0] || null;
      }
    }

    // Build apiOption
    const apiOption = selectedApi ? {
      _id: `rec_api_${idx}`,
      cost: parseFloat(selectedApi.monthly_cost.toFixed(2)),
      savings: currentCost === 0 ? 0 : parseFloat(Math.max(0, currentCost - selectedApi.monthly_cost).toFixed(2)),
      name: selectedApi.name,
      modelId: selectedApi._id,
      performance_score: selectedApi.performance_score,
      category_rank: selectedApi.rank,
      action: currentCost === 0
        ? `Adopt direct enterprise API keys with dedicated SLAs using ${selectedApi.name}.`
        : `Transition active users to direct API keys using ${selectedApi.name}.`,
      statusText: "",
      isAlreadyOptimized: false,
      limits: selectedApi.limits,
      includedModels: [selectedApi.name],
      recommendedModel: selectedApi.name,
      recommendedProvider: getCleanProviderName(selectedApi._id.split('/')[0]),
      inputCostPerM: selectedApi.inputCostPerM,
      outputCostPerM: selectedApi.outputCostPerM,
      defaultInputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 2500000 : 1250000)) : inputTokens,
      defaultOutputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 625000 : 312500)) : outputTokens
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
      savings: currentCost === 0 ? 0 : parseFloat((currentCost - selectedSub.cost).toFixed(2)),
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

  // Compute selectedOptions dynamically prioritizing greatest savings while preserving realistic subscription setups
  const selectedOptions = {};
  recommendations.forEach((r, idx) => {
    const apiSav = r.apiOption?.savings || 0;
    const subSav = r.subscriptionOption?.savings || 0;
    // Default to option with highest savings; if equal or both 0, preserve subscription for seats
    if (apiSav > subSav) {
      selectedOptions[String(idx)] = 'api';
    } else {
      selectedOptions[String(idx)] = 'subscription';
    }
  });

  let totalSelectedSavings = 0;
  parsedAllocations.forEach((alloc, idx) => {
    const choice = selectedOptions[String(idx)] || 'api';
    const opt = choice === 'api' ? recommendations[idx].apiOption : recommendations[idx].subscriptionOption;
    const currentCost = alloc.currentCost;
    const optCost = opt ? opt.cost : currentCost;
    totalSelectedSavings += Math.max(0, currentCost - optCost);
  });

  const totalAnnualSavings = totalSelectedSavings * 12;
  const currentTimestamp = options.createdAt || new Date().toISOString();

  const finalSampleAuditData = {
    _id: "sample_audit_2026",
    userId: "sample_enterprise_user",
    createdAt: currentTimestamp,
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

  if (isCli) {
    console.log('--- AUDEX AI CANONICAL SAMPLE AUDIT RESULT ---');
    console.log('Timestamp:', finalSampleAuditData.createdAt);
    console.log('Total Current Cost:', `$${finalSampleAuditData.totalCurrentCost}`);
    console.log('Total Monthly Savings:', `$${finalSampleAuditData.savings.totalMonthly}`);
    console.log('Percentage Savings:', `${finalSampleAuditData.savings.percentageSavings}%`);
    console.log('\n--- RECOMMENDATIONS ---');
    finalSampleAuditData.savings.recommendations.forEach((r, i) => {
      console.log(`[Alloc ${i}] ${r.tool}`);
      console.log(`   Selected Category: ${r.purpose}`);
      console.log(`   Baseline Model: ${r.originalAlloc.modelName} (Score: ${r.baselineScore}/100, Rank #${r.baselineRank})`);
      console.log(`   API Option: ${r.apiOption.name} ($${r.apiOption.cost}/mo, save $${r.apiOption.savings}/mo, Score: ${r.apiOption.performance_score}/100)`);
      console.log(`   Sub Option: ${r.subscriptionOption.planName} ($${r.subscriptionOption.cost}/mo, save $${r.subscriptionOption.savings}/mo, Model: ${r.subscriptionOption.topModelName || r.subscriptionOption.recommendedModel}, Score: ${r.subscriptionOption.performance_score}/100)`);
    });
  }

  // 1. Write backend data files
  try {
    const outputScriptPath = path.join(__dirname, '../scripts/output_sample_audit.json');
    fs.writeFileSync(outputScriptPath, JSON.stringify(finalSampleAuditData, null, 2), 'utf8');

    const dataSamplePath = path.join(__dirname, '../data/sample_audit.json');
    fs.writeFileSync(dataSamplePath, JSON.stringify(finalSampleAuditData, null, 2), 'utf8');
    if (isCli) console.log('\n✅ Saved to backend/data/sample_audit.json and scripts/output_sample_audit.json');
  } catch (err) {
    console.error('Error writing backend sample audit files:', err.message);
  }

  // 2. Synchronize frontend/src/utils/sampleReportData.js
  try {
    const targetFrontendPath = path.join(__dirname, '../../frontend/src/utils/sampleReportData.js');
    if (fs.existsSync(path.dirname(targetFrontendPath))) {
      const jsContent = `// Canonical Sample Audit Data - Generated from Live Artificial Analysis & LiveBench AI benchmarks\nexport const SAMPLE_AUDIT_DATA = ${JSON.stringify(finalSampleAuditData, null, 2)};\n`;
      fs.writeFileSync(targetFrontendPath, jsContent, 'utf8');
      if (isCli) console.log('✅ Synchronized frontend/src/utils/sampleReportData.js');
    }
  } catch (err) {
    if (isCli) console.warn('Frontend sync note:', err.message);
  }

  // 3. Upsert to MongoDB if connected
  try {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      // Upsert sample_audit_2026 into raw audits collection
      await mongoose.connection.db.collection('audits').updateOne(
        { _id: 'sample_audit_2026' },
        { $set: finalSampleAuditData },
        { upsert: true }
      );

      // Also upsert for 6a4fb719471a97ae89e88f49 ObjectId compatibility
      const hexId = new mongoose.Types.ObjectId('6a4fb719471a97ae89e88f49');
      const hexData = { ...finalSampleAuditData, _id: hexId };
      const Audit = require('../models/Audit');
      await Audit.findOneAndUpdate(
        { _id: hexId },
        hexData,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      if (isCli) console.log('✅ Synchronized sample audit in MongoDB (both string and ObjectId)');
    }
  } catch (err) {
    if (isCli) console.warn('MongoDB sync note:', err.message);
  }

  // 4. Invalidate caches
  try {
    const cache = require('./cacheService');
    await cache.del('audex:audit:sample');
    await cache.del('audex:audit:doc:sample_audit_2026');
    await cache.del('audex:audit:doc:6a4fb719471a97ae89e88f49');
    await cache.del('audex:audit:doc:sample');
  } catch (_) {}

  return finalSampleAuditData;
}

/**
 * Retrieves the latest sample audit report from cache, file, or MongoDB.
 */
async function getSampleReport() {
  const cacheKey = 'audex:audit:sample';
  try {
    const cache = require('./cacheService');
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  } catch (_) {}

  // 1. Check data/sample_audit.json
  const sampleDataPath = path.join(__dirname, '../data/sample_audit.json');
  if (fs.existsSync(sampleDataPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sampleDataPath, 'utf8'));
      try {
        const cache = require('./cacheService');
        await cache.set(cacheKey, data, 3600);
      } catch (_) {}
      return data;
    } catch (_) {}
  }

  // 2. Check output_sample_audit.json
  const outputSamplePath = path.join(__dirname, '../scripts/output_sample_audit.json');
  if (fs.existsSync(outputSamplePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(outputSamplePath, 'utf8'));
      try {
        const cache = require('./cacheService');
        await cache.set(cacheKey, data, 3600);
      } catch (_) {}
      return data;
    } catch (_) {}
  }

  // 3. Check MongoDB
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const Audit = require('../models/Audit');
      const doc = await Audit.findById('6a4fb719471a97ae89e88f49').lean() ||
                  await mongoose.connection.db.collection('audits').findOne({ _id: 'sample_audit_2026' });
      if (doc) {
        try {
          const cache = require('./cacheService');
          await cache.set(cacheKey, doc, 3600);
        } catch (_) {}
        return doc;
      }
    } catch (_) {}
  }

  // 4. Generate fresh if not found
  return await generateSampleReport({ log: false });
}

module.exports = {
  generateSampleReport,
  getSampleReport
};
