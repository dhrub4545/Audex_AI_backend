const express = require('express');
const router = express.Router();
const Audit = require('../models/Audit');
const User = require('../models/User');
const Model = require('../models/Model');
const { auth, optionalAuth } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getRawData, getRankCategory, getSubscriptionTiers, saveSubscriptionTiers } = require('../services/rankStorage');
const { runDailyRankingPipeline } = require('../services/dailyRankingPipeline');
const { syncSubscriptionTiers } = require('../services/subscriptionTierSync');

function redactAuditRecommendations(recommendations) {
  if (!recommendations || !Array.isArray(recommendations)) return recommendations;

  return recommendations.map(rec => {
    const redactedRec = rec.toObject ? rec.toObject() : { ...rec };
    redactedRec.action = '•••••••• (Locked)';
    
    if (redactedRec.apiOption) {
      redactedRec.apiOption = {
        ...redactedRec.apiOption,
        action: '••••••••',
        planName: '••••••••',
        name: '••••••••',
        limits: '••••••••',
        recommendedModel: '••••••••',
        recommendedProvider: '••••••••',
        statusText: 'Locked'
      };
    }
    
    if (redactedRec.subscriptionOption) {
      redactedRec.subscriptionOption = {
        ...redactedRec.subscriptionOption,
        action: '••••••••',
        planName: '••••••••',
        name: '••••••••',
        limits: '••••••••',
        recommendedModel: '••••••••',
        recommendedProvider: '••••••••',
        statusText: 'Locked'
      };
    }
    
    return redactedRec;
  });
}

// Load initial subscription pricing tiers from rankStorage (MongoDB Atlas / disk fallback)
let subscriptionTiers = [];
(async () => {
  try {
    subscriptionTiers = await getSubscriptionTiers();
    if (!subscriptionTiers || subscriptionTiers.length === 0) {
      const tiersPath = path.join(__dirname, '../data/subscription_tiers.json');
      if (fs.existsSync(tiersPath)) {
        subscriptionTiers = JSON.parse(fs.readFileSync(tiersPath, 'utf8'));
      }
    }
  } catch (err) {
    console.error('Error loading subscription_tiers in auditRoutes:', err);
  }
})();

// Find matching subscription tier from the database
function findSubscriptionTier(toolName, planName) {
  if (!subscriptionTiers || subscriptionTiers.length === 0) return null;
  
  const normTool = toolName ? toolName.toLowerCase() : '';
  const normPlan = planName ? planName.toLowerCase() : '';
  
  // 1. Group tiers by provider matching
  let providerTiers = [];
  if (normTool.includes('chatgpt') || normTool.includes('openai')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase() === 'openai');
  } else if (normTool.includes('claude') || normTool.includes('anthropic')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase() === 'anthropic');
  } else if (normTool.includes('gemini') || normTool.includes('google')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase() === 'google');
  } else if (normTool.includes('cursor')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase() === 'cursor');
  } else if (normTool.includes('copilot') || normTool.includes('github')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase() === 'github');
  } else if (normTool.includes('windsurf')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase() === 'windsurf');
  } else if (normTool.includes('v0')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase().includes('v0'));
  } else if (normTool.includes('gamma')) {
    providerTiers = subscriptionTiers.filter(t => t.provider.toLowerCase().includes('gamma'));
  } else {
    providerTiers = subscriptionTiers.filter(t => 
      t.provider.toLowerCase().includes(normTool) || normTool.includes(t.provider.toLowerCase())
    );
  }
  
  if (providerTiers.length === 0) return null;
  
  // 2. Try exact plan name match
  let tier = providerTiers.find(t => t.plan.toLowerCase() === normPlan);
  if (tier) return tier;
  
  // 3. Try partial plan name match
  tier = providerTiers.find(t => t.plan.toLowerCase().includes(normPlan) || normPlan.includes(t.plan.toLowerCase()));
  if (tier) return tier;
  
  // 4. Handle plan semantic fallbacks
  if (normPlan.includes('individual') || normPlan.includes('pro')) {
    tier = providerTiers.find(t => t.plan.toLowerCase().includes('pro'));
    if (tier) return tier;
  }
  if (normPlan.includes('team') || normPlan.includes('business')) {
    tier = providerTiers.find(t => t.plan.toLowerCase().includes('team') || t.plan.toLowerCase().includes('business'));
    if (tier) return tier;
  }
  if (normPlan.includes('max') || normPlan.includes('enterprise') || normPlan.includes('ultra')) {
    tier = providerTiers.find(t => t.plan.toLowerCase().includes('max') || t.plan.toLowerCase().includes('enterprise') || t.plan.toLowerCase().includes('ultra'));
    if (tier) return tier;
  }
  if (normPlan.includes('advanced')) {
    tier = providerTiers.find(t => t.plan.toLowerCase().includes('pro') || t.plan.toLowerCase().includes('plus') || t.plan.toLowerCase().includes('ultra'));
    if (tier) return tier;
  }
  return null;
}

function getRankFileName(purpose) {
  const p = purpose ? purpose.toLowerCase() : 'mixed';
  if (p === 'coding') return 'coding.json';
  if (p === 'writing') return 'creative-writing.json';
  if (p === 'research') return 'research.json';
  if (p === 'math') return 'math.json';
  if (p === 'data') return 'overall.json';
  
  // Languages
  if (p === 'chinese') return 'chinese.json';
  if (p === 'english') return 'english.json';
  if (p === 'french') return 'french.json';
  if (p === 'german') return 'german.json';
  if (p === 'japanese') return 'japanese.json';
  if (p === 'korean') return 'korean.json';
  if (p === 'polish') return 'polish.json';
  if (p === 'russian') return 'russian.json';
  if (p === 'spanish') return 'spanish.json';
  if (p === 'non-english') return 'non-english.json';
  
  // Tasks/Capabilities
  if (p === 'hard-prompts') return 'hard-prompts.json';
  if (p === 'hard-prompts-english') return 'hard-prompts-english.json';
  if (p === 'instruction-following') return 'instruction-following.json';
  if (p === 'multi-turn') return 'multi-turn.json';
  if (p === 'longer-query') return 'longer-query.json';
  if (p === 'expert') return 'expert.json';
  
  // Industry-specific categories
  if (p === 'business') return 'industry-business-and-management-and-financial-operations.json';
  if (p === 'media') return 'industry-entertainment-and-sports-and-media.json';
  if (p === 'legal') return 'industry-legal-and-government.json';
  if (p === 'science') return 'industry-life-and-physical-and-social-science.json';
  if (p === 'math-industry') return 'industry-mathematical.json';
  if (p === 'healthcare') return 'industry-medicine-and-healthcare.json';
  if (p === 'software') return 'industry-software-and-it-services.json';
  if (p === 'literature') return 'industry-writing-and-literature-and-language.json';
  
  return 'overall.json';
}

function getRankCategoryKey(purpose) {
  const p = purpose ? purpose.toLowerCase() : 'mixed';

  if (p === 'coding' || p.includes('code') || p.includes('dev')) return 'coding';
  if (p === 'math' || p.includes('math')) return 'math';
  if (p === 'writing' || p.includes('write')) return 'writing';
  if (p === 'reasoning' || p.includes('logic')) return 'reasoning';
  if (p === 'research' || p.includes('research')) return 'research';
  if (p === 'instruction' || p.includes('instruction')) return 'instruction';
  if (p === 'knowledge') return 'knowledge';
  if (p === 'multilingual' || p.includes('language')) return 'multilingual';
  if (p === 'cheap' || p.includes('cost')) return 'cheap';
  if (p === 'fast' || p.includes('speed')) return 'fast';
  if (p === 'frontier') return 'frontier';
  if (p === 'vision') return 'vision';
  if (p === 'audio') return 'audio';
  if (p === 'open-weights' || p.includes('open')) return 'open-weights';
  if (p === 'agents' || p.includes('agent')) return 'agents';
  if (p === 'long-context' || p.includes('context')) return 'long-context';
  if (p === 'enterprise' || p.includes('business')) return 'enterprise';
  if (p === 'legal' || p.includes('law')) return 'legal';
  if (p === 'medical' || p.includes('healthcare') || p.includes('health')) return 'medical';
  if (p === 'finance' || p.includes('finance')) return 'finance';
  if (p === 'scientific' || p.includes('science')) return 'scientific';
  if (p === 'creative-writing') return 'creative-writing';
  if (p === 'data-analysis') return 'data-analysis';
  if (p === 'roleplay') return 'roleplay';
  if (p === 'translation') return 'translation';
  if (p === 'summarization') return 'summarization';
  if (p === 'extraction') return 'extraction';
  if (p === 'tool-use') return 'tool-use';
  if (p === 'function-calling') return 'function-calling';

  return 'overall';
}

async function getCategoryRankData(purpose) {
  const catKey = getRankCategoryKey(purpose);
  const data = await getRankCategory(catKey);
  return Array.isArray(data) ? data : [];
}

function getEvaluationScore(item, purpose, dbModel, capabilityField) {
  const p = purpose ? purpose.toLowerCase() : 'mixed';
  const evals = item?.evaluations || {};
  let val = null;

  // 1. Try category-specific evaluations first for high-fidelity scores
  if (p === 'coding') {
    val = evals.artificial_analysis_coding_index;
  } else if (p === 'math') {
    val = evals.artificial_analysis_math_index;
  } else if (p === 'writing' || p === 'research') {
    val = evals.gpqa !== undefined ? evals.gpqa * 100 : (evals.hle !== undefined ? evals.hle * 100 : null);
  }
  
  if (val === undefined || val === null) {
    val = evals.artificial_analysis_intelligence_index;
  }
  
  if (val !== undefined && val !== null && !isNaN(val)) {
    return Math.min(100, Math.round(val));
  }

  // 2. If no category-specific evaluations, check Mongoose database capabilities score (synced from overall.json or other files)
  const dbScore = dbModel?.capabilities?.[capabilityField];
  if (dbScore !== undefined && dbScore !== null && dbScore > 0) {
    return dbScore;
  }

  // 3. Fallback to final_score if available
  if (item && item.final_score !== undefined && item.final_score !== null) {
    return Math.min(100, Math.round(item.final_score));
  }
  
  return 0;
}

function findRankEntry(rankData, baselineSlug) {
  if (!baselineSlug || !rankData || rankData.length === 0) return null;
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetClean = clean(baselineSlug);

  // 1. Try exact match
  let match = rankData.find(item => item.slug === baselineSlug);
  if (match) return match;

  // 2. Try exact clean match
  match = rankData.find(item => clean(item.slug || '') === targetClean);
  if (match) return match;

  // 3. Try clean substring match
  match = rankData.find(item => {
    const itemClean = clean(item.slug || '');
    return itemClean.includes(targetClean) || targetClean.includes(itemClean);
  });
  if (match) return match;

  return null;
}

// Shared helper to calculate cost
function calculateModelCost(model, tokens, ratio) {
  const endpoint = model.endpoints?.[0] || { input_cost_per_m: 0, output_cost_per_m: 0 };
  const inputTokens = tokens * ratio;
  const outputTokens = tokens * (1 - ratio);
  const inputCost = (inputTokens / 1000000) * (endpoint.input_cost_per_m || 0);
  const outputCost = (outputTokens / 1000000) * (endpoint.output_cost_per_m || 0);
  return inputCost + outputCost;
}

// Resolves speculative/unreleased or slightly renamed model IDs to active counterparts in the Artificial Analysis models list
function resolveBaselineModel(baselineModelId, allModels, toolName) {
  if (!allModels || allModels.length === 0) return null;

  const clean = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetClean = clean(baselineModelId);

  // 1. Try exact match
  let model = allModels.find(m => m._id === baselineModelId);
  if (model) return model;

  // 2. Try normalized exact match
  model = allModels.find(m => clean(m._id) === targetClean);
  if (model) return model;

  // 3. Try normalized contains match
  model = allModels.find(m => clean(m._id).includes(targetClean) || targetClean.includes(clean(m._id)));
  if (model) return model;

  // 4. Try fuzzy match using base name
  const parts = baselineModelId.split('/');
  const baseName = parts[1] || parts[0];
  const baseClean = clean(baseName);
  
  model = allModels.find(m => {
    const mParts = m._id.split('/');
    const mBase = mParts[1] || mParts[0];
    const mBaseClean = clean(mBase);
    return mBaseClean.includes(baseClean) || baseClean.includes(mBaseClean);
  });
  return model || null;
}

// Check if a model is included in another subscription plan and return plans with lower cost
function findContainingSubscriptions(modelId, modelName, seats, currentCost) {
  const matchingSubs = [];
  if (!subscriptionTiers || subscriptionTiers.length === 0) return matchingSubs;

  const normId = modelId.toLowerCase();
  const normName = modelName ? modelName.toLowerCase() : '';
  const modelProvider = modelId.split('/')[0].toLowerCase();

  for (const tier of subscriptionTiers) {
    let includesModel = false;
    
    if (tier.models && tier.models.length > 0) {
      includesModel = tier.models.some(m => {
        const nm = m.toLowerCase();
        return nm === normId || normId.includes(nm) || nm.includes(normId);
      });
    }

    if (!includesModel && tier.rawModels && tier.rawModels.length > 0 && normName) {
      includesModel = tier.rawModels.some(rm => {
        const nrm = rm.toLowerCase();
        return nrm === normName || normName.includes(nrm) || nrm.includes(normName);
      });
    }

    // Fallback: match by provider brand for new/unreleased models
    if (!includesModel) {
      const tierProvider = tier.provider.toLowerCase();
      if (modelProvider === 'anthropic' && (tierProvider === 'anthropic' || tierProvider === 'claude')) {
        if (tier.plan.toLowerCase() !== 'free') includesModel = true;
      } else if (modelProvider === 'openai' && (tierProvider === 'openai' || tierProvider === 'chatgpt')) {
        if (tier.plan.toLowerCase() !== 'free') includesModel = true;
      } else if (modelProvider === 'google' && (tierProvider === 'google' || tierProvider === 'gemini')) {
        if (tier.plan.toLowerCase() !== 'free') includesModel = true;
      }
    }

    if (includesModel) {
      const altCost = seats * tier.monthlyPrice;
      if (altCost < currentCost) {
        matchingSubs.push({
          provider: tier.provider,
          plan: tier.plan,
          monthly_cost: altCost,
          limits: tier.limits
        });
      }
    }
  }

  // Sort by cost ascending (cheapest first)
  matchingSubs.sort((a, b) => a.monthly_cost - b.monthly_cost);
  return matchingSubs;
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
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

function getSubscriptionPrice(toolName, plan) {
  const tier = findSubscriptionTier(toolName, plan);
  if (tier) {
    return tier.monthlyPrice;
  }
  return 0;
}


// Route to run and save a new audit
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { optimizationGoal = 'performance', costCutPercentage = 50, qualityThreshold = 90, allocations } = req.body;

    if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return res.status(400).json({ error: 'Missing required allocations data' });
    }

    let user = null;
    if (req.user) {
      user = await User.findById(req.user.id);
    }

    // Count unique tools configured
    const uniqueTools = [...new Set(allocations.map(a => a.toolName))];
    const numTools = uniqueTools.length;

    // Enforce backend tool limits based on user plan / tier
    let maxAllowedTools = 2; // Default for Free tier or unauthenticated users
    if (user) {
      if (user.plan === 'enterprise' || (user.credits && user.credits.proMax > 0)) {
        maxAllowedTools = Infinity;
      } else if (user.plan === 'pro' || (user.credits && user.credits.pro > 0)) {
        maxAllowedTools = 15;
      }
    }

    if (numTools > maxAllowedTools) {
      const isFree = maxAllowedTools === 2;
      const errorMsg = isFree
        ? `Maximum 2 tools allowed per audit analysis on the Free plan. Please upgrade your subscription to analyze more tools.`
        : `Maximum 15 tools allowed per audit analysis on the Pro plan. Please upgrade to Enterprise for unlimited tools.`;
      return res.status(403).json({
        error: errorMsg,
        code: 'TOOL_LIMIT_EXCEEDED',
        maxAllowed: maxAllowedTools,
        upgradeRequired: true
      });
    }

    let tierUsed = 'starter';
    if (numTools > 15) {
      tierUsed = 'proMax';
    } else if (numTools > 2) {
      tierUsed = 'pro';
    }

    // Fetch all models for API routing recommendations
    const docs = await Model.find({});
    const allModels = docs.map(d => d.toObject());

    const recommendations = [];
    let totalMonthlySavings = 0;
    const parsedAllocations = [];

    // First pass: parse allocations and calculate current costs and total current budget
    let totalCurrentBudget = 0;
    const allocationDetails = [];

    for (let allocIndex = 0; allocIndex < allocations.length; allocIndex++) {
      const alloc = allocations[allocIndex];
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
          type,
          toolName,
          plan,
          seats,
          purpose,
          pricePerSeat
        });

        tier = findSubscriptionTier(toolName, plan);
        const category = tier ? tier.category : 'Chat & Reasoning';
        isMedia = ['media (image)', 'media (video)', 'media (audio)', 'ui & layouts'].includes(category.toLowerCase());

        if (!isMedia) {
          baselineModelIds = (tier && tier.models && tier.models.length > 0) ? tier.models : [];
          let maxBaselineScore = -1;
          for (const mid of baselineModelIds) {
            const resolved = resolveBaselineModel(mid, allModels, toolName);
            if (resolved) {
              const score = resolved.capabilities?.[capabilityField] || 0;
              if (score > maxBaselineScore) {
                maxBaselineScore = score;
                primaryBaselineModel = resolved;
              }
            }
          }
          if (primaryBaselineModel) {
            const promptTokensPerSeat = purpose === 'Coding' ? 10000000 : 5000000;
            const completionTokensPerSeat = purpose === 'Coding' ? 2500000 : 1250000;
            const totalPromptTokens = seats * promptTokensPerSeat;
            const totalCompletionTokens = seats * completionTokensPerSeat;
            totalTokens = totalPromptTokens + totalCompletionTokens;
            inputRatio = totalTokens > 0 ? (totalPromptTokens / totalTokens) : 0.8;

            const rankData = await getCategoryRankData(purpose);
            const baselineSlug = primaryBaselineModel._id.split('/')[1] || '';
            const baselineRankEntry = findRankEntry(rankData, baselineSlug);
            baselineScore = baselineRankEntry ? getEvaluationScore(baselineRankEntry, purpose, primaryBaselineModel, capabilityField) : (primaryBaselineModel.capabilities?.[capabilityField] || 0);
          }
        }
      } else if (type === 'api') {
        modelId = alloc.modelId;
        inputTokens = parseFloat(alloc.inputTokens) || 10000000;
        outputTokens = parseFloat(alloc.outputTokens) || 2500000;
        totalTokens = inputTokens + outputTokens;
        inputRatio = totalTokens > 0 ? (inputTokens / totalTokens) : 0.8;

        parsedAllocations.push({
          type,
          toolName,
          seats,
          purpose,
          modelId,
          inputTokens,
          outputTokens
        });

        let currentModel = allModels.find(m => m._id === modelId);
        if (!currentModel && allModels.length > 0) {
          const targetBase = (modelId.split('/')[1] || modelId).toLowerCase();
          currentModel = allModels.find(m => m._id.toLowerCase().includes(targetBase));
        }

        if (currentModel) {
          primaryBaselineModel = currentModel;
          currentCost = calculateModelCost(currentModel, totalTokens, inputRatio);
          const rankData = await getCategoryRankData(purpose);
          const currentSlug = currentModel._id.split('/')[1] || '';
          const currentRankEntry = findRankEntry(rankData, currentSlug);
          baselineScore = currentRankEntry ? getEvaluationScore(currentRankEntry, purpose, currentModel, capabilityField) : (currentModel.capabilities?.[capabilityField] || 0);
        }
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
    }

    // Inject currentCost, baselineModelId, and baselineModels into parsedAllocations so the frontend can read it
    allocationDetails.forEach((detail, i) => {
      if (parsedAllocations[i]) {
        parsedAllocations[i].currentCost = detail.currentCost;
        parsedAllocations[i].baselineModelId = detail.primaryBaselineModel ? detail.primaryBaselineModel._id : null;
        parsedAllocations[i].baselineModels = detail.tier ? (detail.tier.rawModels || []) : [];
      }
    });

    let apiMonthlySavings = 0;
    let subMonthlySavings = 0;

    for (let detailIndex = 0; detailIndex < allocationDetails.length; detailIndex++) {
      const detail = allocationDetails[detailIndex];
      const {
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
      } = detail;

      // Process all allocations including $0/mo free ones

      const rankData = await getCategoryRankData(purpose);

      // Resolve the API model for this allocation (needed for both baseline calc and target model below)
      const currentModel = (type === 'api' && modelId)
        ? (allModels.find(m => m._id === modelId) ||
           allModels.find(m => m._id && m._id.toLowerCase().includes(modelId.toLowerCase())))
        : null;

      // Determine baseline rank and score
      let baselineRank = 9999;
      let computedBaselineScore = baselineScore;

      if (type === 'subscription') {
        const matchingTier = findSubscriptionTier(toolName, plan);
        if (matchingTier) {
          const models = matchingTier.models || [];
          for (const mid of models) {
            const resolved = resolveBaselineModel(mid, allModels, toolName);
            if (resolved) {
              const currentSlug = resolved._id.split('/')[1] || '';
              const rankEntry = findRankEntry(rankData, currentSlug);
              if (rankEntry) {
                baselineRank = Math.min(baselineRank, parseInt(rankEntry.rank) || 9999);
                computedBaselineScore = Math.max(computedBaselineScore, Math.min(100, Math.round(rankEntry.final_score)));
              } else {
                computedBaselineScore = Math.max(computedBaselineScore, resolved.capabilities?.[capabilityField] || 0);
              }
            }
          }
        }
      } else {
        // api
        if (currentModel) {
          const currentSlug = currentModel._id.split('/')[1] || '';
          const rankEntry = findRankEntry(rankData, currentSlug);
          if (rankEntry) {
            baselineRank = parseInt(rankEntry.rank) || 9999;
            computedBaselineScore = Math.min(100, Math.round(rankEntry.final_score));
          } else {
            computedBaselineScore = currentModel.capabilities?.[capabilityField] || 0;
          }
        }
      }

      // OPTION A: Best Model API Candidates
      let apiCandidates = [];
      if (rankData.length > 0) {
        for (const item of rankData) {
          if (!item.slug) continue;
          let dbModel = allModels.find(m => m._id && m._id.split && m._id.split('/')[1] === item.slug);
          if (!dbModel) {
            dbModel = allModels.find(m => m._id && (m._id.toLowerCase().includes(item.slug.toLowerCase()) || item.slug.toLowerCase().includes((m._id.split && m._id.split('/')[1] || '').toLowerCase())));
          }
          if (dbModel && dbModel.endpoints && dbModel.endpoints.length > 0) {
            const ep = dbModel.endpoints[0];
            if ((ep.input_cost_per_m || 0) === 0 && (ep.output_cost_per_m || 0) === 0) {
              continue;
            }
            const cost = calculateModelCost(dbModel, totalTokens, inputRatio);
            const score = Math.min(100, Math.round(item.final_score));
            const contextStr = dbModel.context_length ? (dbModel.context_length >= 1000000 ? `${(dbModel.context_length / 1000000).toFixed(0)}M` : `${(dbModel.context_length / 1000).toFixed(0)}K`) : 'N/A';
            const limitsStr = `Pay-as-you-go rates: $${ep.input_cost_per_m.toFixed(2)}/1M input, $${ep.output_cost_per_m.toFixed(2)}/1M output. Context: ${contextStr}.`;
            apiCandidates.push({
              _id: dbModel._id,
              name: dbModel.name,
              rank: item.rank,
              performance_score: score,
              monthly_cost: cost,
              isCurrent: dbModel._id === modelId,
              limits: limitsStr,
              context_length: dbModel.context_length,
              inputCostPerM: ep.input_cost_per_m || 0,
              outputCostPerM: ep.output_cost_per_m || 0
            });
          }
        }
      } else {
        apiCandidates = allModels
          .filter(m => {
            if (!m.endpoints || m.endpoints.length === 0) return false;
            const ep = m.endpoints[0];
            return (ep.input_cost_per_m || 0) > 0 || (ep.output_cost_per_m || 0) > 0;
          })
          .map((m, idx) => {
            const cost = calculateModelCost(m, totalTokens, inputRatio);
            const score = m.capabilities?.[capabilityField] || 0;
            const ep = m.endpoints[0];
            const contextStr = m.context_length ? (m.context_length >= 1000000 ? `${(m.context_length / 1000000).toFixed(0)}M` : `${(m.context_length / 1000).toFixed(0)}K`) : 'N/A';
            const limitsStr = `Pay-as-you-go rates: $${ep.input_cost_per_m.toFixed(2)}/1M input, $${ep.output_cost_per_m.toFixed(2)}/1M output. Context: ${contextStr}.`;
            return {
              _id: m._id,
              name: m.name,
              rank: idx + 1,
              performance_score: score,
              monthly_cost: cost,
              isCurrent: m._id === modelId,
              limits: limitsStr,
              context_length: m.context_length,
              inputCostPerM: ep.input_cost_per_m || 0,
              outputCostPerM: ep.output_cost_per_m || 0
            };
          });
      }

      let selectedApi = null;
      let apiStatusText = "";

      if (optimizationGoal === 'quality') {
        if (apiCandidates.length > 0) {
          apiCandidates.sort((a, b) => a.rank - b.rank || b.performance_score - a.performance_score);
          selectedApi = apiCandidates[0];
          if (selectedApi.isCurrent) {
            apiStatusText = "Best model API already used.";
          }
        }
      } else if (optimizationGoal === 'performance') {
        let compatible = [];
        if (baselineRank !== 9999) {
          compatible = apiCandidates.filter(c => c.monthly_cost < currentCost && c.rank <= baselineRank);
        } else {
          compatible = apiCandidates.filter(c => c.monthly_cost < currentCost && c.performance_score >= computedBaselineScore);
        }
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.rank - b.rank || b.performance_score - a.performance_score || a.monthly_cost - b.monthly_cost);
          selectedApi = compatible[0];
        } else {
          apiCandidates.sort((a, b) => a.rank - b.rank);
          if (apiCandidates[0] && (apiCandidates[0]._id === modelId || (type === 'api' && baselineRank <= apiCandidates[0].rank))) {
            apiStatusText = "Best model API already used.";
          }
        }
      } else if (optimizationGoal === 'cost') {
        const maxAllowedCost = currentCost * (1 - costCutPercentage / 100);
        let compatible = apiCandidates.filter(c => c.monthly_cost <= maxAllowedCost);
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.rank - b.rank || b.performance_score - a.performance_score || a.monthly_cost - b.monthly_cost);
          selectedApi = compatible[0];
        }
      }

      // OPTION B: Subscriptions
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

      let targetModelId = "";
      let targetModelName = "";
      let targetModelDev = "";

      if (selectedApi) {
        targetModelId = selectedApi._id;
        targetModelName = selectedApi.name;
      } else if (currentModel) {
        targetModelId = currentModel._id;
        targetModelName = currentModel.name;
        targetModelDev = currentModel.developer;
      } else {
        const topModelSlug = rankData[0]?.slug;
        if (topModelSlug) {
          const resolved = allModels.find(m => m._id && m._id.split && m._id.split('/')[1] === topModelSlug);
          if (resolved) {
            targetModelId = resolved._id;
            targetModelName = resolved.name;
            targetModelDev = resolved.developer;
          }
        }
      }

      if (targetModelId && !targetModelDev) {
        const resolved = allModels.find(m => m._id === targetModelId);
        if (resolved) {
          targetModelDev = resolved.developer;
        }
      }

      const matchesModel = (tier) => {
        if (!targetModelId) return false;
        const hasModelId = tier.models && tier.models.some(m => m.toLowerCase() === targetModelId.toLowerCase() || targetModelId.toLowerCase().includes(m.toLowerCase()));
        const hasModelName = tier.rawModels && tier.rawModels.some(m => m.toLowerCase() === targetModelName.toLowerCase() || targetModelName.toLowerCase().includes(m.toLowerCase()) || targetModelName.toLowerCase().replace(/[^a-z0-9]/g, '').includes(m.toLowerCase().replace(/[^a-z0-9]/g, '')));
        return hasModelId || hasModelName;
      };

      const matchesProvider = (tier) => {
        if (!targetModelDev) return false;
        const p = tier.provider.toLowerCase();
        const mp = targetModelDev.toLowerCase();
        return p.includes(mp) || mp.includes(p);
      };

      const filteredTiers = subscriptionTiers.filter(t => allowedCategories.includes(t.category.toLowerCase()));

      let subMatchTiers = filteredTiers.filter(t => matchesModel(t));
      if (subMatchTiers.length === 0 && targetModelDev) {
        subMatchTiers = filteredTiers.filter(t => matchesProvider(t));
      }
      if (subMatchTiers.length === 0) {
        subMatchTiers = filteredTiers;
      }

      const includeFree = type === 'subscription' && plan.toLowerCase() === 'free';
      if (!includeFree) {
        subMatchTiers = subMatchTiers.filter(t => t.plan.toLowerCase() !== 'free' && t.monthlyPrice > 0);
      }

      subMatchTiers.forEach(t => {
        const cost = seats * t.monthlyPrice;
        let bestRank = 9999;
        let bestScore = 0;

        const models = t.models || [];
        const rawModels = t.rawModels || [];

        for (const mid of models) {
          const resolved = resolveBaselineModel(mid, allModels, t.provider);
          if (resolved) {
            const currentSlug = resolved._id.split('/')[1] || '';
            const rankEntry = rankData.find(item => item.slug === currentSlug) ||
                              rankData.find(item => item.slug && (item.slug.toLowerCase().includes(currentSlug.toLowerCase()) || currentSlug.toLowerCase().includes(item.slug.toLowerCase())));
            if (rankEntry) {
              bestRank = Math.min(bestRank, rankEntry.rank);
              bestScore = Math.max(bestScore, Math.min(100, Math.round(rankEntry.final_score)));
            } else {
              bestScore = Math.max(bestScore, resolved.capabilities?.[capabilityField] || 0);
            }
          }
        }

        for (const rm of rawModels) {
          const rankEntry = rankData.find(item => item.name.toLowerCase().includes(rm.toLowerCase()) || rm.toLowerCase().includes(item.name.toLowerCase()));
          if (rankEntry) {
            bestRank = Math.min(bestRank, rankEntry.rank);
            bestScore = Math.max(bestScore, Math.min(100, Math.round(rankEntry.final_score)));
          }
        }

        if (bestRank === 9999) {
          bestRank = 800;
          bestScore = 20;
        }

        const isCurrent = type === 'subscription' && 
                          (t.provider.toLowerCase() === toolName.toLowerCase() || toolName.toLowerCase().includes(t.provider.toLowerCase())) &&
                          t.plan.toLowerCase() === plan.toLowerCase();

        subCandidates.push({
          tier: t,
          cost,
          rank: bestRank,
          performance_score: bestScore,
          isCurrent
        });
      });

      let selectedSub = null;
      let subStatusText = "";

      if (optimizationGoal === 'quality') {
        if (subCandidates.length > 0) {
          subCandidates.sort((a, b) => a.rank - b.rank || b.performance_score - a.performance_score);
          selectedSub = subCandidates[0];
          if (selectedSub.isCurrent) {
            subStatusText = "Best subscription already used.";
          }
        }
      } else if (optimizationGoal === 'performance') {
        let compatible = [];
        if (baselineRank !== 9999) {
          compatible = subCandidates.filter(c => c.cost < currentCost && c.rank <= baselineRank);
        } else {
          compatible = subCandidates.filter(c => c.cost < currentCost && c.performance_score >= computedBaselineScore);
        }
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.rank - b.rank || b.performance_score - a.performance_score || a.cost - b.cost);
          selectedSub = compatible[0];
        } else {
          subCandidates.sort((a, b) => a.rank - b.rank);
          if (subCandidates[0] && (subCandidates[0].isCurrent || (type === 'subscription' && baselineRank <= subCandidates[0].rank))) {
            subStatusText = "Best subscription already used.";
          }
        }
      } else if (optimizationGoal === 'cost') {
        const maxAllowedCost = currentCost * (1 - costCutPercentage / 100);
        let compatible = subCandidates.filter(c => c.cost <= maxAllowedCost);
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.rank - b.rank || b.performance_score - a.performance_score || a.cost - b.cost);
          selectedSub = compatible[0];
        }
      }

      // Build structured Options
      const apiOption = selectedApi ? {
        cost: selectedApi.monthly_cost,
        savings: currentCost - selectedApi.monthly_cost,
        name: selectedApi.name,
        modelId: selectedApi._id,
        action: (type === 'api' && selectedApi.isCurrent)
          ? "Your current model API is already the best choice. Keep using it."
          : `Transition active users to direct API keys using ${selectedApi.name}.`,
        statusText: (type === 'api' && selectedApi.isCurrent) ? (apiStatusText || "Optimized") : "",
        limits: selectedApi.limits,
        includedModels: [selectedApi.name],
        recommendedModel: selectedApi.name,
        recommendedProvider: getCleanProviderName(selectedApi._id.split('/')[0]),
        inputCostPerM: selectedApi.inputCostPerM,
        outputCostPerM: selectedApi.outputCostPerM,
        defaultInputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 10000000 : 5000000)) : inputTokens,
        defaultOutputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 2500000 : 1250000)) : outputTokens
      } : {
        cost: currentCost,
        savings: 0,
        name: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model"),
        modelId: modelId,
        action: (type === 'api')
          ? "Your current model API is already the best choice. Keep using it."
          : `Transition active users to direct API keys using ${primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model")}.`,
        statusText: (type === 'api') ? (apiStatusText || "Optimized") : "",
        limits: primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints.length > 0
          ? `Pay-as-you-go rates: $${primaryBaselineModel.endpoints[0].input_cost_per_m.toFixed(2)}/1M input, $${primaryBaselineModel.endpoints[0].output_cost_per_m.toFixed(2)}/1M output. Context: ${primaryBaselineModel.context_length ? (primaryBaselineModel.context_length >= 1000000 ? `${(primaryBaselineModel.context_length / 1000000).toFixed(0)}M` : `${(primaryBaselineModel.context_length / 1000).toFixed(0)}K`) : 'N/A'}.`
          : "Pay-as-you-go token consumption limits.",
        includedModels: primaryBaselineModel ? [primaryBaselineModel.name] : (modelId ? [modelId] : []),
        recommendedModel: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model"),
        recommendedProvider: primaryBaselineModel ? getCleanProviderName(primaryBaselineModel._id.split('/')[0]) : getCleanProviderName(toolName),
        inputCostPerM: (primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints[0]) ? (primaryBaselineModel.endpoints[0].input_cost_per_m || 0) : 0,
        outputCostPerM: (primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints[0]) ? (primaryBaselineModel.endpoints[0].output_cost_per_m || 0) : 0,
        defaultInputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 10000000 : 5000000)) : inputTokens,
        defaultOutputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 2500000 : 1250000)) : outputTokens
      };

      const subscriptionOption = selectedSub ? {
        planName: `${selectedSub.tier.provider} ${selectedSub.tier.plan}`,
        cost: selectedSub.cost,
        savings: currentCost - selectedSub.cost,
        limits: selectedSub.tier.limits,
        includedModels: selectedSub.tier.rawModels || [],
        modelId: selectedSub.tier.models?.[0] || null,
        action: (type === 'subscription' && selectedSub.isCurrent)
          ? "Your current subscription is already the best choice. Keep using it."
          : `Migrate to the ${selectedSub.tier.provider} ${selectedSub.tier.plan} subscription.`,
        statusText: (type === 'subscription' && selectedSub.isCurrent) ? (subStatusText || "Optimized") : "",
        recommendedModel: selectedSub.tier.plan,
        recommendedProvider: getCleanProviderName(selectedSub.tier.provider)
      } : {
        planName: `${toolName} ${plan || "Free"}`,
        cost: currentCost,
        savings: 0,
        limits: tier ? tier.limits : "Free plan limits",
        includedModels: tier ? (tier.rawModels || []) : [],
        modelId: tier?.models?.[0] || null,
        action: (type === 'subscription')
          ? "Your current subscription is already the best choice. Keep using it."
          : `Migrate to the ${toolName} ${plan || "Free"} subscription.`,
        statusText: (type === 'subscription') ? (subStatusText || "Optimized") : "",
        recommendedModel: plan || "Free",
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
        tool: toolDesc,
        issue: issueDesc,
        action: "Select the most suitable option below.",
        monthlySavings: Math.max(apiOption ? apiOption.savings : 0, subscriptionOption ? subscriptionOption.savings : 0),
        apiOption,
        subscriptionOption,
        originalAlloc: {
          type,
          toolName,
          plan,
          seats,
          purpose,
          currentCost,
          modelId,
          provider: currentProvider,
          modelName: currentModelName
        }
      });
    }

    totalMonthlySavings = Math.max(apiMonthlySavings, subMonthlySavings);
    const totalAnnualSavings = totalMonthlySavings * 12;

    const totalSeats = allocations.reduce((acc, a) => acc + (parseInt(a.seats) || 1), 0);
    const primaryUseCase = allocations[0]?.purpose || 'Mixed';

    const auditData = {
      userId: user ? user._id : null,
      teamSize: totalSeats,
      useCase: primaryUseCase,
      optimizationGoal,
      costCutPercentage,
      totalCurrentCost: totalCurrentBudget,
      allocations: parsedAllocations,
      savings: {
        totalMonthly: totalMonthlySavings,
        totalAnnual: totalAnnualSavings,
        apiMonthly: apiMonthlySavings,
        apiAnnual: apiMonthlySavings * 12,
        subMonthly: subMonthlySavings,
        subAnnual: subMonthlySavings * 12,
        recommendations
      },
      tierUsed: tierUsed,
      createdAt: new Date()
    };

    const audit = new Audit(auditData);
    await audit.save();
    console.log('Saved audit in MongoDB:', audit._id);

    // Calculate isUnlocked dynamically
    let isUnlocked = false;
    if (numTools <= 2) {
      isUnlocked = true;
    } else if (user) {
      if (user.plan === 'enterprise') {
        isUnlocked = true;
      } else if (user.plan === 'pro' && numTools <= 15) {
        isUnlocked = true;
      }
    }

    const returnedAudit = audit.toObject();
    returnedAudit.isUnlocked = isUnlocked;

    if (!isUnlocked) {
      if (returnedAudit.savings && returnedAudit.savings.recommendations) {
        returnedAudit.savings.recommendations = redactAuditRecommendations(returnedAudit.savings.recommendations);
      }
    }

    return res.status(201).json({
      ...returnedAudit,
      totalCurrentCost: totalCurrentBudget,
      updatedCredits: user ? user.credits : null
    });
  } catch (error) {
    console.error('Audit Save Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Route to get all audits (requires authentication)
router.get('/', auth, async (req, res) => {
  try {
    const audits = await Audit.find({ userId: req.user.id }).sort({ createdAt: -1 });
    const user = await User.findById(req.user.id);
    
    // Hydrate baselineModels for all audits returned in the list
    const auditsObj = audits.map(audit => {
      const auditObj = audit.toObject();
      const uniqueTools = [...new Set((auditObj.allocations || []).map(a => a.toolName))];
      const numTools = uniqueTools.length;

      let isUnlocked = false;
      if (numTools <= 2) {
        isUnlocked = true;
      } else if (user) {
        if (user.plan === 'enterprise') {
          isUnlocked = true;
        } else if (user.plan === 'pro' && numTools <= 15) {
          isUnlocked = true;
        } else if (user.unlockedAudits && user.unlockedAudits.some(aid => aid.toString() === auditObj._id.toString())) {
          isUnlocked = true;
        }
      }
      
      auditObj.isUnlocked = isUnlocked;

      if (auditObj.allocations && Array.isArray(auditObj.allocations)) {
        auditObj.allocations.forEach(alloc => {
          if (alloc.type === 'subscription' && (!alloc.baselineModels || alloc.baselineModels.length === 0)) {
            const tier = findSubscriptionTier(alloc.toolName, alloc.plan);
            alloc.baselineModels = tier ? (tier.rawModels || []) : [];
          }
        });
      }
      return auditObj;
    });

    return res.json(auditsObj);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to get single audit by ID (requires authentication)
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const audit = await Audit.findById(id);

    if (!audit) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    // Verify ownership (except for the sample audit)
    const isSampleAudit = id === '6a4fb719471a97ae89e88f49';
    if (!isSampleAudit && audit.userId) {
      if (!req.user || audit.userId.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Access denied. You do not own this audit report.' });
      }
    }

    let user = null;
    if (req.user) {
      user = await User.findById(req.user.id);
    }

    const uniqueTools = [...new Set((audit.allocations || []).map(a => a.toolName))];
    const numTools = uniqueTools.length;

    let isUnlocked = false;
    if (numTools <= 2) {
      isUnlocked = true;
    } else if (user) {
      if (user.plan === 'enterprise') {
        isUnlocked = true;
      } else if (user.plan === 'pro' && numTools <= 15) {
        isUnlocked = true;
      } else if (user.unlockedAudits && user.unlockedAudits.some(aid => aid.toString() === audit._id.toString())) {
        isUnlocked = true;
      }
    }

    const auditObj = audit.toObject();
    auditObj.isUnlocked = isUnlocked;

    if (!isUnlocked) {
      if (auditObj.savings && auditObj.savings.recommendations) {
        auditObj.savings.recommendations = redactAuditRecommendations(auditObj.savings.recommendations);
      }
    }

    if (auditObj.allocations && Array.isArray(auditObj.allocations)) {
      auditObj.allocations.forEach((alloc, index) => {
        if (alloc.type === 'subscription' && (!alloc.baselineModels || alloc.baselineModels.length === 0)) {
          const tier = findSubscriptionTier(alloc.toolName, alloc.plan);
          alloc.baselineModels = tier ? (tier.rawModels || []) : [];
        }
      });
    }

    return res.json(auditObj);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to delete a single audit by ID (requires authentication)
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const audit = await Audit.findById(id);

    if (!audit) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    // Verify ownership
    if (audit.userId && audit.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You do not own this audit report.' });
    }

    await Audit.deleteOne({ _id: id });
    return res.json({ message: 'Audit deleted successfully', id });
  } catch (error) {
    console.error('Error deleting audit:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to update an audit's selected options (requires authentication)
router.put('/:id/options', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { selectedOptions } = req.body;
    
    const audit = await Audit.findById(id);
    if (!audit) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    // Verify ownership
    if (audit.userId && audit.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    audit.selectedOptions = selectedOptions || {};
    await audit.save();

    return res.json({ success: true, selectedOptions: audit.selectedOptions });
  } catch (error) {
    console.error('Error saving selected options:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Two-API capability and pricing recommendation auditor
router.post('/audit-recommendation', async (req, res) => {
  try {
    const currentModelId = req.body.currentModelId;
    if (!currentModelId) {
      return res.status(400).json({ error: 'currentModelId is required' });
    }
    const targetUseCase = req.body.targetUseCase || 'Mixed';
    const monthlyTokens = parseFloat(req.body.monthlyTokens) || 10000000;
    const inputRatio = parseFloat(req.body.inputTokenRatio) || 0.8;
    const optimizationGoal = req.body.optimizationGoal || 'performance';
    const costCutPercentage = parseFloat(req.body.costCutPercentage) || 50;
    console.log('[DEBUG] /audit-recommendation:', {
      currentModelId,
      targetUseCase,
      monthlyTokens,
      inputRatio,
      optimizationGoal,
      costCutPercentage
    });

    const capabilityField = {
      'Coding': 'coding_score',
      'Writing': 'reasoning_score',
      'Math': 'math_score',
      'Research': 'reasoning_score',
      'Mixed': 'aa_index_score'
    }[targetUseCase] || 'aa_index_score';

    // 1. Fetch models
    let docs = await Model.find({});
    let allModels = docs.map(d => d.toObject());

    // If no models at all, try syncing first
    if (allModels.length === 0) {
      console.log('🔄 Database is empty, auto-triggering local sync/seeding in recommendation route...');
      const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');
      await syncArtificialAnalysis();
      docs = await Model.find({});
      allModels = docs.map(d => d.toObject());
    }

    if (allModels.length === 0) {
      return res.status(503).json({ error: 'Database is empty. Please wait for the initial synchronization pipeline to complete, or check backend logs.' });
    }



    // 2. Find current model
    let currentModel = allModels.find(m => m._id === currentModelId);
    if (!currentModel) {
      // Try fuzzy matching
      const targetBase = (currentModelId.split('/')[1] || currentModelId).toLowerCase();
      currentModel = allModels.find(m => m._id.toLowerCase().includes(targetBase)) || null;
    }
    if (!currentModel) {
      return res.status(404).json({ error: 'Baseline model data not found in database.' });
    }

    const rankData = await getCategoryRankData(targetUseCase);
    
    const currentSlug = (currentModel._id.split('/')[1] || currentModel._id).toLowerCase();
    const currentRankEntry = findRankEntry(rankData, currentSlug);
    const currentRank = currentRankEntry ? (parseInt(currentRankEntry.rank) || 999) : 999;
    const currentScore = currentRankEntry ? getEvaluationScore(currentRankEntry, targetUseCase, currentModel, capabilityField) : (currentModel.capabilities?.[capabilityField] || 0);
    const currentRating = currentRankEntry?.rating || 0;
    
    const currentInputCost = (currentRankEntry?.pricing?.price_1m_input_tokens !== undefined && currentRankEntry?.pricing?.price_1m_input_tokens !== null)
      ? parseFloat(currentRankEntry.pricing.price_1m_input_tokens)
      : (currentModel.endpoints?.[0]?.input_cost_per_m || 0);

    const currentOutputCost = (currentRankEntry?.pricing?.price_1m_output_tokens !== undefined && currentRankEntry?.pricing?.price_1m_output_tokens !== null)
      ? parseFloat(currentRankEntry.pricing.price_1m_output_tokens)
      : (currentModel.endpoints?.[0]?.output_cost_per_m || 0);

    const currentCost = ((currentInputCost * inputRatio) + (currentOutputCost * (1 - inputRatio))) * (monthlyTokens / 1000000);

    // 3. Map alternatives
    let alternatives = [];
    if (rankData.length > 0) {
      for (const item of rankData) {
        if (!item.slug) continue;
        
        let dbModel = allModels.find(m => m._id.split('/')[1] === item.slug);
        if (!dbModel) {
          dbModel = allModels.find(m => m._id.toLowerCase().includes(item.slug.toLowerCase()) || item.slug.toLowerCase().includes(m._id.toLowerCase().split('/')[1] || ''));
        }
        
        const inputCost = (item.pricing?.price_1m_input_tokens !== undefined && item.pricing?.price_1m_input_tokens !== null)
          ? parseFloat(item.pricing.price_1m_input_tokens)
          : (dbModel?.endpoints?.[0]?.input_cost_per_m || 0);

        const outputCost = (item.pricing?.price_1m_output_tokens !== undefined && item.pricing?.price_1m_output_tokens !== null)
          ? parseFloat(item.pricing.price_1m_output_tokens)
          : (dbModel?.endpoints?.[0]?.output_cost_per_m || 0);

        const cacheReadCost = (item.pricing?.price_1m_cache_read_tokens !== undefined && item.pricing?.price_1m_cache_read_tokens !== null)
          ? parseFloat(item.pricing.price_1m_cache_read_tokens)
          : (dbModel?.endpoints?.[0]?.cache_read_cost_per_m || 0);

        if (inputCost > 0 || outputCost > 0) {
          const modelId = item.modelId || dbModel?._id || (item.slug ? `${(item.organization || item.creator || 'ai').toLowerCase()}/${item.slug}` : '');
          if (!modelId) continue;

          // De-duplicate: skip if already mapped
          if (alternatives.some(alt => alt._id === modelId || alt.slug === item.slug)) {
            continue;
          }

          const score = getEvaluationScore(item, targetUseCase, dbModel, capabilityField);
          const rating = item.rating || 0;
          const tokens_per_second = item.median_output_tokens_per_second || item.tokens_per_second || dbModel?.capabilities?.tokens_per_second || 0;
          const time_to_first_token_ms = item.median_time_to_first_token_seconds ? Math.round(item.median_time_to_first_token_seconds * 1000) : (dbModel?.capabilities?.time_to_first_token_ms || 0);

          const cost = ((inputCost * inputRatio) + (outputCost * (1 - inputRatio))) * (monthlyTokens / 1000000);
          const valScore = cost > 0 ? (score / cost) : 0;

          alternatives.push({
            _id: modelId,
            slug: item.slug,
            name: item.name || dbModel?.name || item.slug,
            developer: item.organization || item.creator || dbModel?.developer || 'Unknown',
            context_length: item.context_length || dbModel?.context_length || 128000,
            rating: rating,
            performance_score: score,
            tokens_per_second: tokens_per_second,
            time_to_first_token_ms: time_to_first_token_ms,
            cost_per_m_input: inputCost,
            cost_per_m_output: outputCost,
            cache_read_cost_per_m: cacheReadCost,
            monthly_cost: cost,
            value_score: valScore,
            category_rank: parseInt(item.rank) || 999
          });
        }
      }
    } else {
      alternatives = allModels
        .filter(m => m.capabilities && m.capabilities[capabilityField] && m.endpoints && m.endpoints.length > 0)
        .map(m => {
          const cost = calculateModelCost(m, monthlyTokens, inputRatio);
          const score = m.capabilities[capabilityField];
          const valScore = cost > 0 ? (score / cost) : 0;
          return {
            _id: m._id,
            slug: m._id.split('/')[1] || m._id,
            name: m.name,
            developer: m.developer,
            context_length: m.context_length,
            rating: 0,
            performance_score: score,
            tokens_per_second: m.capabilities.tokens_per_second || 0,
            time_to_first_token_ms: m.capabilities.time_to_first_token_ms || 0,
            cost_per_m_input: m.endpoints[0].input_cost_per_m,
            cost_per_m_output: m.endpoints[0].output_cost_per_m,
            cache_read_cost_per_m: m.endpoints[0].cache_read_cost_per_m || 0,
            monthly_cost: cost,
            value_score: valScore,
            category_rank: 999
          };
        });
    }
    
    alternatives = alternatives.filter(alt => alt.monthly_cost > 0 && alt.cost_per_m_input >= 0 && alt.cost_per_m_output >= 0);

    // Apply filtering and compute recommendation score according to user optimizationGoal
    let filteredAlternatives = [];
    if (optimizationGoal === 'performance') {
      // Mode 1: Performance Preservation
      // The model with the better rank and the low cost than current selected model in selected category
      filteredAlternatives = alternatives.filter(alt => {
        if (alt.slug === currentSlug || alt._id === currentModelId) return false;
        if (alt.monthly_cost >= currentCost) return false;

        if (currentRank !== 999 && alt.category_rank !== 999) {
          return alt.category_rank <= currentRank;
        }
        if (currentRating > 0 && alt.rating > 0) {
          return alt.rating >= currentRating;
        }
        return alt.performance_score >= currentScore;
      });

      filteredAlternatives.forEach(alt => {
        const rankScore = alt.category_rank !== 999 ? (10000 - alt.category_rank) * 10000 : 0;
        const qualityVal = alt.rating > 0 ? alt.rating : (alt.performance_score * 20);
        const costEfficiency = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
        alt.recommendation_score = rankScore + (qualityVal * 1000) + costEfficiency;
      });

    } else if (optimizationGoal === 'cost') {
      // Mode 2: Cost Reduction
      // Suggest the model with low cost (user percentage selection) and the best rank within low cost models
      const maxAllowedCost = currentCost * (1 - (costCutPercentage / 100));
      filteredAlternatives = alternatives.filter(alt => 
        alt.slug !== currentSlug &&
        alt._id !== currentModelId &&
        alt.monthly_cost <= maxAllowedCost
      );

      filteredAlternatives.forEach(alt => {
        const rankScore = alt.category_rank !== 999 ? (10000 - alt.category_rank) * 10000 : 0;
        const qualityVal = alt.rating > 0 ? alt.rating : (alt.performance_score * 20);
        const costEfficiency = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
        alt.recommendation_score = rankScore + (qualityVal * 1000) + costEfficiency;
      });

    } else if (optimizationGoal === 'quality') {
      // Mode 3: Quality Focus
      // Only suggest the model which is at the top rank at the selected category, ignoring cost
      filteredAlternatives = alternatives.filter(alt => {
        if (alt.slug === currentSlug || alt._id === currentModelId) return false;
        
        if (currentRank !== 999 && alt.category_rank !== 999) {
          return alt.category_rank < currentRank;
        }
        if (currentRating > 0 && alt.rating > 0) {
          return alt.rating > currentRating;
        }
        return alt.performance_score > currentScore;
      });

      filteredAlternatives.forEach(alt => {
        const rankScore = alt.category_rank !== 999 ? (10000 - alt.category_rank) * 10000 : 0;
        const qualityVal = alt.rating > 0 ? alt.rating : (alt.performance_score * 20);
        alt.recommendation_score = rankScore + (qualityVal * 1000);
      });

    } else {
      // Fallback
      filteredAlternatives = alternatives.filter(alt => 
        alt.slug !== currentSlug &&
        alt._id !== currentModelId &&
        alt.monthly_cost < currentCost
      );
      filteredAlternatives.forEach(alt => {
        const qualityVal = alt.rating > 0 ? alt.rating : (alt.performance_score * 20);
        alt.recommendation_score = qualityVal * 1000;
      });
    }

    // Sort by recommendation score descending
    filteredAlternatives.sort((a, b) => b.recommendation_score - a.recommendation_score);

    // Limit to top 5
    const topAlternatives = filteredAlternatives.slice(0, 5);

    // 4. Construct reports
    const recommendations = topAlternatives.map(alt => {
      const savings = currentCost - alt.monthly_cost;
      const performanceRetained = currentScore > 0 ? (alt.performance_score / currentScore) * 100 : 100;

      return {
        modelId: alt._id,
        name: alt.name,
        developer: alt.developer,
        context_length: alt.context_length,
        performance_score: alt.performance_score,
        tokens_per_second: alt.tokens_per_second,
        time_to_first_token_ms: alt.time_to_first_token_ms,
        cost_per_m_input: alt.cost_per_m_input,
        cost_per_m_output: alt.cost_per_m_output,
        cache_read_cost_per_m: alt.cache_read_cost_per_m,
        monthly_cost: alt.monthly_cost,
        projected_monthly_savings: parseFloat(savings.toFixed(2)),
        projected_annual_savings: parseFloat((savings * 12).toFixed(2)),
        performance_retained_percentage: parseFloat(performanceRetained.toFixed(2)),
        recommendation_score: parseFloat(alt.recommendation_score.toFixed(4))
      };
    });

    res.json({
      currentBaseline: {
        modelId: currentModel._id,
        name: currentModel.name,
        performance_score: currentScore,
        monthly_cost: parseFloat(currentCost.toFixed(2)),
        tokens_per_second: currentModel.capabilities?.tokens_per_second || 0,
        time_to_first_token_ms: currentModel.capabilities?.time_to_first_token_ms || 0,
        cost_per_m_input: currentModel.endpoints?.[0]?.input_cost_per_m || 0,
        cost_per_m_output: currentModel.endpoints?.[0]?.output_cost_per_m || 0
      },
      recommendations
    });
  } catch (error) {
    console.error('Audit Recommendation Route Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});
// Vercel Cron & Manual Trigger Endpoint for Daily Artificial Analysis Sync
const handleCronSync = async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    const isVercelCron = Boolean(req.headers['x-vercel-cron']);
    
    // Validate secret if configured
    if (cronSecret && !isVercelCron) {
      const providedSecret = req.query.secret || (authHeader ? authHeader.replace('Bearer ', '') : null);
      if (providedSecret !== cronSecret) {
        return res.status(401).json({ error: 'Unauthorized: Invalid CRON_SECRET token.' });
      }
    }

    console.log('⏰ Vercel Cron / Manual Sync triggered: Running daily ranking pipeline...');
    const result = await runDailyRankingPipeline();

    return res.json({
      success: true,
      message: 'Daily Artificial Analysis sync and ranking pipeline executed successfully.',
      timestamp: new Date().toISOString(),
      result
    });
  } catch (error) {
    console.error('❌ Vercel Cron / Manual Sync Error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Daily sync pipeline execution failed.',
      details: error.message
    });
  }
};

router.get('/cron/sync', handleCronSync);
router.post('/cron/sync', handleCronSync);

// Route to fetch raw Artificial Analysis API data for the home page analysis dashboard
router.get('/analysis/raw-data', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let rawData = null;
    if (req.query.refresh === 'true') {
      console.log('🔄 Forced refresh requested on raw-data endpoint: Triggering ranking pipeline...');
      await runDailyRankingPipeline();
    }
    
    rawData = await getRawData();

    if (!rawData) {
      console.log('🔄 Raw data empty in DB & disk. Auto-triggering initial pipeline sync...');
      await runDailyRankingPipeline();
      rawData = await getRawData();
    }

    if (!rawData) {
      return res.status(404).json({ error: 'Raw analysis data not found. Please run database synchronization first.' });
    }

    const sources = rawData.sources || {};

    // 1. Process LLMs
    const rawLlms = Array.isArray(sources.llms) ? sources.llms : (sources.llms?.data || []);
    const processedLlms = rawLlms.map(item => {
      const pricing = item.pricing || {};
      const evaluations = item.evaluations || {};
      
      const inputCost = parseFloat(pricing.price_1m_input_tokens) || 0;
      const outputCost = parseFloat(pricing.price_1m_output_tokens) || 0;
      // Blended price assumes a standard 3:1 input:output tokens ratio
      const blendedPrice = (inputCost * 0.75) + (outputCost * 0.25);

      const rawIntel = evaluations.artificial_analysis_intelligence_index !== undefined ? evaluations.artificial_analysis_intelligence_index : (item.intelligenceIndex !== undefined ? item.intelligenceIndex : item.category_scores?.overall);
      const rawCoding = evaluations.artificial_analysis_coding_index !== undefined ? evaluations.artificial_analysis_coding_index : (item.codingIndex !== undefined ? item.codingIndex : item.category_scores?.coding);
      const rawMath = evaluations.artificial_analysis_math_index !== undefined ? evaluations.artificial_analysis_math_index : (item.mathIndex !== undefined ? item.mathIndex : item.category_scores?.math);

      const parsedIntel = !isNaN(parseFloat(rawIntel)) ? parseFloat(rawIntel) : null;
      const parsedCoding = !isNaN(parseFloat(rawCoding)) ? parseFloat(rawCoding) : null;
      const parsedMath = !isNaN(parseFloat(rawMath)) ? parseFloat(rawMath) : null;

      return {
        slug: item.slug,
        name: item.name,
        creator: item.model_creator?.name || item.organization || 'Unknown',
        release_date: item.release_date,
        intelligence_index: parsedIntel,
        coding_index: parsedCoding,
        math_index: parsedMath,
        gpqa: parseFloat(evaluations.gpqa || item.gpqa) || null,
        hle: parseFloat(evaluations.hle || item.hle) || null,
        throughput: parseFloat(item.median_output_tokens_per_second) || null,
        ttft: parseFloat(item.median_time_to_first_token_seconds) || null,
        inputCost,
        outputCost,
        blendedPrice
      };
    }).sort((a, b) => {
      const valA = typeof a.intelligence_index === 'number' ? a.intelligence_index : -1;
      const valB = typeof b.intelligence_index === 'number' ? b.intelligence_index : -1;
      return valB - valA;
    });

    // 2. Process Media categories
    const mediaCategories = {};
    const mediaKeys = ['text_to_image', 'image_editing', 'text_to_speech', 'text_to_video', 'image_to_video'];
    
    mediaKeys.forEach(key => {
      const items = Array.isArray(sources[key]) ? sources[key] : (sources[key]?.data || []);
      mediaCategories[key] = items.map(item => ({
        name: item.name,
        creator: item.model_creator?.name || 'Unknown',
        elo: parseInt(item.elo) || null,
        rank: parseInt(item.rank) || null,
        release_date: item.release_date
      })).sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity));
    });

    res.json({
      fetched_at: rawData.fetched_at_utc,
      categories: rawData.categories || {},
      llms: processedLlms,
      media: mediaCategories
    });
  } catch (error) {
    console.error('Error fetching raw analysis data:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Route to fetch raw subscription tiers list (with prices)
router.get('/subscription-tiers/raw', (req, res) => {
  try {
    res.json(subscriptionTiers || []);
  } catch (error) {
    console.error('Error serving raw subscription tiers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to fetch grouped and formatted subscription tools dynamically from rankStorage / MongoDB
router.get('/subscription-tiers/list', async (req, res) => {
  try {
    const liveTiers = await getSubscriptionTiers();
    const activeTiers = (liveTiers && liveTiers.length > 0) ? liveTiers : subscriptionTiers;

    if (!activeTiers || activeTiers.length === 0) {
      return res.json([]);
    }

    const getEmojiForProvider = (name) => {
      const n = name.toLowerCase();
      if (n.includes('openai') || n.includes('chatgpt')) return '🟢';
      if (n.includes('claude') || n.includes('anthropic')) return '🟧';
      if (n.includes('google') || n.includes('gemini')) return '🔷';
      if (n.includes('github') || n.includes('copilot')) return '🤖';
      if (n.includes('cursor')) return '💻';
      if (n.includes('windsurf') || n.includes('codeium')) return '⛵';
      if (n.includes('perplexity')) return '🔍';
      if (n.includes('deepseek')) return '🐳';
      if (n.includes('mistral')) return '🍊';
      if (n.includes('meta')) return '♾️';
      if (n.includes('xai') || n.includes('grok')) return '🐦';
      if (n.includes('v0')) return '▲';
      if (n.includes('gamma')) return '✨';
      if (n.includes('midjourney')) return '🎨';
      if (n.includes('runway')) return '🎬';
      if (n.includes('elevenlabs')) return '🗣️';
      if (n.includes('suno')) return '🎵';
      return '🔧';
    };

    const getDescriptionForProvider = (name) => {
      const n = name.toLowerCase();
      if (n.includes('openai') || n.includes('chatgpt')) return 'OpenAI ChatGPT';
      if (n.includes('claude') || n.includes('anthropic')) return 'Anthropic assistant';
      if (n.includes('google') || n.includes('gemini')) return "Google's AI model";
      if (n.includes('github') || n.includes('copilot')) return 'GitHub AI assistant';
      if (n.includes('cursor')) return 'AI code editor';
      if (n.includes('windsurf')) return 'AI-powered IDE';
      if (n.includes('perplexity')) return 'AI search companion';
      if (n.includes('deepseek')) return 'DeepSeek assistant';
      if (n.includes('mistral')) return 'Mistral Le Chat';
      if (n.includes('meta')) return 'Meta AI assistant';
      if (n.includes('xai')) return 'xAI Grok search';
      if (n.includes('v0')) return 'Vercel UI generator';
      if (n.includes('gamma')) return 'AI presentation generator';
      if (n.includes('midjourney')) return 'AI image generator';
      if (n.includes('runway')) return 'AI video generator';
      if (n.includes('elevenlabs')) return 'AI voice generator';
      if (n.includes('suno')) return 'AI music generator';
      return `${name} AI integration`;
    };

    const grouped = {};
    activeTiers.forEach(tier => {
      const prov = tier.provider || 'Other';
      const key = prov.toLowerCase();
      if (!grouped[key]) {
        grouped[key] = {
          id: prov,
          name: prov,
          desc: getDescriptionForProvider(prov),
          icon: getEmojiForProvider(prov),
          type: 'subscription',
          plans: [],
          defaultPlan: '',
          defaultSeats: (prov.toLowerCase().includes('github') || prov.toLowerCase().includes('cursor') || prov.toLowerCase().includes('anthropic') || prov.toLowerCase().includes('claude')) ? 5 : 1
        };
      }
      if (!grouped[key].plans.includes(tier.plan)) {
        grouped[key].plans.push(tier.plan);
      }
    });

    Object.keys(grouped).forEach(key => {
      const item = grouped[key];
      const proPlan = item.plans.find(p => p.toLowerCase().includes('pro') || p.toLowerCase().includes('plus'));
      item.defaultPlan = proPlan || item.plans[0] || 'Free';
    });

    return res.json(Object.values(grouped));
  } catch (error) {
    console.error('Error serving subscription-tiers list:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to manually or remotely trigger subscription tier synchronization
router.post('/subscription-tiers/sync', async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    if (adminSecret) {
      const providedSecret = req.query.secret || (authHeader ? authHeader.replace('Bearer ', '') : null);
      if (providedSecret !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized: Invalid administrative sync secret token.' });
      }
    }

    console.log('⚡ Manual / Webhook trigger: Starting subscription tier synchronization...');
    const updatedTiers = await syncSubscriptionTiers();
    subscriptionTiers = updatedTiers;
    return res.json({
      success: true,
      message: `Successfully synchronized ${updatedTiers.length} subscription tiers.`,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error executing subscription-tiers sync route:', error);
    return res.status(500).json({ error: 'Failed to synchronize subscription tiers', details: error.message });
  }
});

// Route to get list of all models for dropdown baselines and Direct API Models panel
router.get('/models/list', async (req, res) => {
  try {
    const rawData = await getRawData();
    const modelsMap = new Map();

    // 1. Ingest from rawData category ranks (where live ELO ratings and rankings reside)
    if (rawData?.categories) {
      for (const catKey of Object.keys(rawData.categories)) {
        const catList = rawData.categories[catKey];
        if (Array.isArray(catList)) {
          for (const m of catList) {
            if (!m.slug && !m.modelId) continue;
            const slug = m.slug || m.modelId?.split('/')[1] || m.modelId;
            const creator = m.organization || m.model_creator?.name || m.developer || 'Unknown';
            let creatorPrefix = creator.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            if (creatorPrefix === 'meta') creatorPrefix = 'meta-llama';
            if (creatorPrefix === 'mistral') creatorPrefix = 'mistralai';
            if (creatorPrefix === 'xai' || creatorPrefix === 'spacexai') creatorPrefix = 'x-ai';
            const modelId = m.modelId || `${creatorPrefix}/${slug}`;

            const rawName = m.name || m.model_name || slug;
            const cleanName = rawName.replace(/^[^:]+:\s*/, '');
            const displayName = `${creator}: ${cleanName}`;

            if (!modelsMap.has(slug)) {
              modelsMap.set(slug, {
                id: modelId,
                slug: slug,
                name: displayName,
                rawName: cleanName,
                developer: creator,
                creator: creator,
                rating: Number(m.rating || m.arena_elo || 0),
                pricing: m.pricing || null,
                evaluations: m.evaluations || null,
                context_length: m.context_length || null,
                tokens_per_second: m.median_output_tokens_per_second || null
              });
            } else {
              const existing = modelsMap.get(slug);
              if ((!existing.rating || existing.rating === 0) && m.rating) existing.rating = Number(m.rating);
              if (!existing.pricing && m.pricing) existing.pricing = m.pricing;
            }
          }
        }
      }
    }

    // 2. Ingest from rawData sources.llms.data (620+ models) to catch any remaining models
    const sourceLlms = rawData?.sources?.llms?.data || rawData?.llms || [];
    for (const m of sourceLlms) {
      if (!m.slug && !m.id) continue;
      const slug = m.slug || m.id;
      const creator = m.model_creator?.name || m.creator || m.organization || 'Unknown';
      let creatorPrefix = creator.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (creatorPrefix === 'meta') creatorPrefix = 'meta-llama';
      if (creatorPrefix === 'mistral') creatorPrefix = 'mistralai';
      if (creatorPrefix === 'xai' || creatorPrefix === 'spacexai') creatorPrefix = 'x-ai';
      const modelId = `${creatorPrefix}/${slug}`;

      const rawName = m.name || m.model_name || slug;
      const cleanName = rawName.replace(/^[^:]+:\s*/, '');
      const displayName = `${creator}: ${cleanName}`;

      if (!modelsMap.has(slug)) {
        modelsMap.set(slug, {
          id: modelId,
          slug: slug,
          name: displayName,
          rawName: cleanName,
          developer: creator,
          creator: creator,
          rating: Number(m.rating || m.arena_elo || 0),
          pricing: m.pricing || null,
          evaluations: m.evaluations || null,
          context_length: m.context_length || null,
          tokens_per_second: m.median_output_tokens_per_second || null
        });
      } else {
        const existing = modelsMap.get(slug);
        if (!existing.evaluations && m.evaluations) existing.evaluations = m.evaluations;
        if (!existing.pricing && m.pricing) existing.pricing = m.pricing;
        if (!existing.context_length && m.context_length) existing.context_length = m.context_length;
      }
    }

    // 3. Fallback to MongoDB Model collection if empty
    if (modelsMap.size === 0) {
      const allModels = await Model.find({}).sort({ name: 1 });
      for (const m of allModels) {
        const dev = m.developer || m.name?.split(':')[0] || 'Unknown';
        modelsMap.set(m._id, {
          id: m._id,
          slug: m._id.split('/')[1] || m._id,
          name: m.name || m._id,
          rawName: (m.name || m._id).replace(/^[^:]+:\s*/, ''),
          developer: dev,
          creator: dev,
          rating: 1200
        });
      }
    }

    const formatted = Array.from(modelsMap.values());

    // Sort by rating descending (highest capability latest models first)
    formatted.sort((a, b) => {
      const diff = (b.rating || 0) - (a.rating || 0);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });

    res.json(formatted);
  } catch (error) {
    console.error('Audit Models List Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Route to generate comparison report using Gemini API
router.post('/compare/report', optionalAuth, async (req, res) => {
  const { baseline, recommended } = req.body;
  
  if (!baseline || !recommended) {
    return res.status(400).json({ error: 'Missing baseline or recommended model details' });
  }

  let user = null;
  if (req.user) {
    user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Authenticated user not found.' });
    }
    if (!user.credits) {
      user.credits = { starter: 0, pro: 0, proMax: 0 };
    }
    
    // Deduct 1 credit (any type: starter, pro, proMax)
    if (user.credits.starter > 0) {
      user.credits.starter -= 1;
    } else if (user.credits.pro > 0) {
      user.credits.pro -= 1;
    } else if (user.credits.proMax > 0) {
      user.credits.proMax -= 1;
    } else {
      return res.status(402).json({
        error: 'No credits remaining to generate this report. Please buy credits or subscribe.',
        credits: user.credits
      });
    }
    
    user.markModified('credits');
    await user.save();
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.Gemini_Api_key;
  if (!geminiKey) {
    return res.status(500).json({ error: 'Gemini API Key is not configured on the server.' });
  }

  const prompt = `You are an expert AI subscription auditor and spend optimizer. 
Given details of two models (a baseline model and a recommended alternative model), generate a comprehensive spend optimization and migration report.

Baseline Model:
- Name: ${baseline.name}
- Creator: ${baseline.creator || baseline.developer || 'Unknown'}
- Model ID: ${baseline.modelId || 'Unknown'}
- Cost per 1M Input Tokens: $${baseline.cost_per_m_input ?? baseline.pricing?.price_1m_input_tokens ?? 0}
- Cost per 1M Output Tokens: $${baseline.cost_per_m_output ?? baseline.pricing?.price_1m_output_tokens ?? 0}
- Tokens Per Second (Speed): ${baseline.tokens_per_second ?? baseline.throughput ?? 'N/A'}
- Coding Index: ${baseline.coding_index ?? 'N/A'}
- Intelligence Index: ${baseline.intelligence_index ?? 'N/A'}
- Context Length: ${baseline.context_length ?? 'N/A'}

Recommended Model:
- Name: ${recommended.name}
- Creator: ${recommended.creator || recommended.developer || 'Unknown'}
- Model ID: ${recommended.modelId || 'Unknown'}
- Cost per 1M Input Tokens: $${recommended.cost_per_m_input ?? recommended.pricing?.price_1m_input_tokens ?? 0}
- Cost per 1M Output Tokens: $${recommended.cost_per_m_output ?? recommended.pricing?.price_1m_output_tokens ?? 0}
- Tokens Per Second (Speed): ${recommended.tokens_per_second ?? recommended.throughput ?? 'N/A'}
- Coding Index: ${recommended.coding_index ?? 'N/A'}
- Intelligence Index: ${recommended.intelligence_index ?? 'N/A'}
- Context Length: ${recommended.context_length ?? 'N/A'}

Please write:
1. An architectural spend decision insight explaining why the switch makes sense, comparing their capability boundaries, spends, and inference speed/efficiency.
2. A checklist of route migration steps specific to these models.
3. A migration command sequence/script description.

Return ONLY a valid JSON object matching the following structure (no markdown wrappers, no backticks, just raw JSON):
{
  "architectural_insight": {
    "title": "🧠 Architectural Spend Decision Insight",
    "paragraphs": [
      "A detailed paragraph explaining why switching from the baseline model to the recommended model makes architectural and financial sense...",
      "Another paragraph detailing the quality analysis and comparing capabilities..."
    ],
    "quality_analysis_box": "Quality Analysis: The recommended alternative retains approximately X% of the baseline capability score while running on a more efficient inference infrastructure."
  },
  "route_migration_checklist": {
    "title": "🚀 Route Migration Checklist",
    "steps": [
      {
        "bold_text": "API Keys",
        "detail": "Secure key pairs for Recommended Creator from their developer portal."
      },
      {
        "bold_text": "Endpoint Update",
        "detail": "Modify your API clients config setting the target model ID parameter to Recommended Model ID."
      },
      {
        "bold_text": "Fallback Buffer",
        "detail": "Implement retry routers to fall back to Baseline Model Name if rate limits are exceeded."
      }
    ],
    "migration_script": "The custom migration script or command sequence..."
  }
}`;

  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      contents: [
        {
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: 'Received empty response from Gemini API' });
    }

    const report = JSON.parse(text.trim());
    res.json({
      report,
      updatedCredits: req.user ? user.credits : null
    });
  } catch (error) {
    console.error('Error generating Gemini report:', error.response ? error.response.data : error.message);
    res.status(500).json({ 
      error: 'Failed to generate comparison report with Gemini', 
      details: error.response ? error.response.data : error.message 
    });
  }
});

// Admin Route to manually trigger data synchronization/seeding
router.post('/admin/sync', async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    if (adminSecret) {
      const providedSecret = req.query.secret || (authHeader ? authHeader.replace('Bearer ', '') : null);
      if (providedSecret !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized: Invalid admin secret token.' });
      }
    }

    const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');
    await syncArtificialAnalysis();
    res.json({ message: 'Synchronization and seeding completed successfully.' });
  } catch (err) {
    console.error('Manual synchronization failed:', err);
    res.status(500).json({ error: 'Manual synchronization failed', details: err.message });
  }
});

module.exports = router;
