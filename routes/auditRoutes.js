const express = require('express');
const router = express.Router();
const Audit = require('../models/Audit');
const User = require('../models/User');
const Model = require('../models/Model');
const { auth, optionalAuth } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

// Load subscription pricing tiers from JSON file
let subscriptionTiers = [];
try {
  const tiersPath = path.join(__dirname, '../data/subscription_tiers.json');
  if (fs.existsSync(tiersPath)) {
    subscriptionTiers = JSON.parse(fs.readFileSync(tiersPath, 'utf8'));
  } else {
    console.warn('subscription_tiers.json not found at:', tiersPath);
  }
} catch (err) {
  console.error('Error loading subscription_tiers.json:', err);
}

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

function getCategoryRankData(purpose) {
  const filename = getRankFileName(purpose);
  const filePath = path.join(__dirname, '../data/rank', filename);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Error reading rank file ${filename}:`, e);
    }
  }
  return [];
}

function getEvaluationScore(item, purpose, dbModel, capabilityField) {
  if (item && item.final_score !== undefined && item.final_score !== null) {
    return Math.min(100, Math.round(item.final_score));
  }

  const p = purpose ? purpose.toLowerCase() : 'mixed';
  const evals = item?.evaluations || {};
  let val = null;
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
  
  if (val === undefined || val === null) {
    return dbModel?.capabilities?.[capabilityField] || 0;
  }
  
  return Math.min(100, Math.round(val));
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
      const altCost = tier.isPerSeat ? (seats * tier.monthlyPrice) : tier.monthlyPrice;
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

    let user;
    if (req.user) {
      user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ error: 'Authenticated user not found.' });
      }

      if (!user.credits) {
        user.credits = { starter: 0, pro: 0, proMax: 0 };
      }

      // Count unique tools configured
      const uniqueTools = [...new Set(allocations.map(a => a.toolName))];
      const numTools = uniqueTools.length;

      if (numTools > 4) {
        // Requires Pro or Pro Max
        if (user.credits.pro > 0) {
          user.credits.pro -= 1;
        } else if (user.credits.proMax > 0) {
          user.credits.proMax -= 1;
        } else {
          return res.status(402).json({
            error: 'Insufficient premium credits. Auditing more than 4 models requires Pro or Pro Max credits.',
            credits: user.credits
          });
        }
      } else {
        // Can use Starter, Pro, or Pro Max
        if (user.credits.starter > 0) {
          user.credits.starter -= 1;
        } else if (user.credits.pro > 0) {
          user.credits.pro -= 1;
        } else if (user.credits.proMax > 0) {
          user.credits.proMax -= 1;
        } else {
          return res.status(402).json({
            error: 'No credits remaining. Please buy credits or subscribe.',
            credits: user.credits
          });
        }
      }

      user.markModified('credits');
      await user.save();
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

    allocations.forEach((alloc, allocIndex) => {
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

            const rankData = getCategoryRankData(purpose);
            const baselineSlug = primaryBaselineModel._id.split('/')[1] || '';
            const baselineRankEntry = rankData.find(item => item.slug === baselineSlug) || 
                                      rankData.find(item => item.slug && (item.slug.toLowerCase().includes(baselineSlug.toLowerCase()) || baselineSlug.toLowerCase().includes(item.slug.toLowerCase())));
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
          const rankData = getCategoryRankData(purpose);
          const currentSlug = currentModel._id.split('/')[1] || '';
          const currentRankEntry = rankData.find(item => item.slug === currentSlug) || 
                                   rankData.find(item => item.slug && (item.slug.toLowerCase().includes(currentSlug.toLowerCase()) || currentSlug.toLowerCase().includes(item.slug.toLowerCase())));
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
        totalTokens,
        inputRatio,
        capabilityField
      });
    });

    let apiMonthlySavings = 0;
    let subMonthlySavings = 0;

    allocationDetails.forEach((detail) => {
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
        totalTokens,
        inputRatio,
        capabilityField
      } = detail;

      // Process all allocations including $0/mo free ones

      const rankData = getCategoryRankData(purpose);

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
            const resolved = allModels.find(m => m._id === mid || (m._id && m._id.toLowerCase().includes(mid.toLowerCase())));
            if (resolved) {
              const currentSlug = resolved._id.split('/')[1] || '';
              const rankEntry = rankData.find(item => item.slug === currentSlug) ||
                                rankData.find(item => item.slug && (item.slug.toLowerCase().includes(currentSlug.toLowerCase()) || currentSlug.toLowerCase().includes(item.slug.toLowerCase())));
              if (rankEntry) {
                baselineRank = Math.min(baselineRank, rankEntry.rank);
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
          const rankEntry = rankData.find(item => item.slug === currentSlug) ||
                            rankData.find(item => item.slug && (item.slug.toLowerCase().includes(currentSlug.toLowerCase()) || currentSlug.toLowerCase().includes(item.slug.toLowerCase())));
          if (rankEntry) {
            baselineRank = rankEntry.rank;
            computedBaselineScore = Math.min(100, Math.round(rankEntry.final_score));
          } else {
            computedBaselineScore = currentModel.capabilities?.[capabilityField] || 0;
          }
        }
      }

      if (baselineRank === 9999) {
        baselineRank = 500;
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
            apiCandidates.push({
              _id: dbModel._id,
              name: dbModel.name,
              rank: item.rank,
              performance_score: score,
              monthly_cost: cost,
              isCurrent: dbModel._id === modelId
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
            return {
              _id: m._id,
              name: m.name,
              rank: idx + 1,
              performance_score: score,
              monthly_cost: cost,
              isCurrent: m._id === modelId
            };
          });
      }

      let selectedApi = null;
      let apiStatusText = "";

      if (optimizationGoal === 'quality') {
        if (apiCandidates.length > 0) {
          apiCandidates.sort((a, b) => a.rank - b.rank);
          selectedApi = apiCandidates[0];
          if (selectedApi.isCurrent) {
            apiStatusText = "Best model API already used.";
          }
        }
      } else if (optimizationGoal === 'performance') {
        let compatible = apiCandidates.filter(c => c.monthly_cost < currentCost && (c.rank <= baselineRank || c.performance_score >= computedBaselineScore));
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.rank - b.rank);
          selectedApi = compatible[0];
        } else {
          apiCandidates.sort((a, b) => a.rank - b.rank);
          if (apiCandidates[0] && (apiCandidates[0]._id === modelId || baselineRank === 1)) {
            apiStatusText = "Best model API already used.";
          }
        }
      } else if (optimizationGoal === 'cost') {
        const maxAllowedCost = currentCost * (1 - costCutPercentage / 100);
        let compatible = apiCandidates.filter(c => c.monthly_cost <= maxAllowedCost);
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.rank - b.rank);
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
        const cost = t.isPerSeat ? (seats * t.monthlyPrice) : t.monthlyPrice;
        let bestRank = 9999;
        let bestScore = 0;

        const models = t.models || [];
        const rawModels = t.rawModels || [];

        for (const mid of models) {
          const resolved = allModels.find(m => m._id === mid || (m._id && m._id.toLowerCase().includes(mid.toLowerCase())));
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
          subCandidates.sort((a, b) => a.cost - b.cost || a.rank - b.rank);
          selectedSub = subCandidates[0];
          if (selectedSub.isCurrent) {
            subStatusText = "Best subscription already used.";
          }
        }
      } else if (optimizationGoal === 'performance') {
        let compatible = subCandidates.filter(c => c.cost < currentCost);
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.cost - b.cost || a.rank - b.rank);
          selectedSub = compatible[0];
        } else {
          subCandidates.sort((a, b) => a.cost - b.cost || a.rank - b.rank);
          if (subCandidates[0] && (subCandidates[0].isCurrent || baselineRank <= subCandidates[0].rank)) {
            subStatusText = "Best subscription already used.";
          }
        }
      } else if (optimizationGoal === 'cost') {
        const maxAllowedCost = currentCost * (1 - costCutPercentage / 100);
        let compatible = subCandidates.filter(c => c.cost <= maxAllowedCost);
        if (compatible.length > 0) {
          compatible.sort((a, b) => a.cost - b.cost || a.rank - b.rank);
          selectedSub = compatible[0];
        }
      }

      // Build structured Options
      const apiOption = selectedApi ? {
        cost: selectedApi.monthly_cost,
        savings: currentCost - selectedApi.monthly_cost,
        name: selectedApi.name,
        modelId: selectedApi._id,
        action: selectedApi.isCurrent 
          ? "Your current model API is already the best choice. Keep using it."
          : `Transition active users to direct API keys using ${selectedApi.name}.`,
        statusText: apiStatusText || (selectedApi.isCurrent ? "Optimized" : "")
      } : {
        cost: currentCost,
        savings: 0,
        name: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Free Model"),
        modelId: modelId,
        action: "Your current model API is already the best choice. Keep using it.",
        statusText: apiStatusText || "Optimized"
      };

      const subscriptionOption = selectedSub ? {
        planName: `${selectedSub.tier.provider} ${selectedSub.tier.plan}`,
        cost: selectedSub.cost,
        savings: currentCost - selectedSub.cost,
        limits: selectedSub.tier.limits,
        action: selectedSub.isCurrent
          ? "Your current subscription is already the best choice. Keep using it."
          : `Migrate to the ${selectedSub.tier.provider} ${selectedSub.tier.plan} subscription.`,
        statusText: subStatusText || (selectedSub.isCurrent ? "Optimized" : "")
      } : {
        planName: `${toolName} ${plan || "Free"}`,
        cost: currentCost,
        savings: 0,
        limits: tier ? tier.limits : "Free plan limits",
        action: "Your current subscription is already the best choice. Keep using it.",
        statusText: subStatusText || "Optimized"
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

      recommendations.push({
        tool: toolDesc,
        issue: issueDesc,
        action: "Select the most suitable option below.",
        monthlySavings: Math.max(apiOption ? apiOption.savings : 0, subscriptionOption ? subscriptionOption.savings : 0),
        apiOption,
        subscriptionOption
      });
    });

    totalMonthlySavings = Math.max(apiMonthlySavings, subMonthlySavings);
    const totalAnnualSavings = totalMonthlySavings * 12;

    const totalSeats = allocations.reduce((acc, a) => acc + (parseInt(a.seats) || 1), 0);
    const primaryUseCase = allocations[0]?.purpose || 'Mixed';

    const auditData = {
      userId: req.user ? req.user.id : null,
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
      createdAt: new Date()
    };

    const audit = new Audit(auditData);
    await audit.save();
    console.log('Saved audit in MongoDB:', audit._id);
    return res.status(201).json({
      ...audit.toObject(),
      totalCurrentCost: totalCurrentBudget,
      updatedCredits: req.user ? user.credits : null
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
    return res.json(audits);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to get single audit by ID (requires authentication)
router.get('/:id', auth, async (req, res) => {
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

    return res.json(audit);
  } catch (error) {
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

    const capabilityField = {
      'Coding': 'coding_score',
      'Writing': 'reasoning_score',
      'Math': 'math_score',
      'Research': 'reasoning_score',
      'Mixed': 'aa_index_score'
    }[targetUseCase] || 'aa_index_score';

    // 1. Fetch models
    const docs = await Model.find({});
    const allModels = docs.map(d => d.toObject());

    // If no models at all, return error
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

    const rankData = getCategoryRankData(targetUseCase);
    
    const currentSlug = currentModel._id.split('/')[1] || '';
    const currentRankEntry = rankData.find(item => item.slug === currentSlug) || 
                             rankData.find(item => item.slug && (item.slug.toLowerCase().includes(currentSlug.toLowerCase()) || currentSlug.toLowerCase().includes(item.slug.toLowerCase())));
    const currentRank = currentRankEntry ? (parseInt(currentRankEntry.rank) || 999) : 999;
    const currentScore = currentRankEntry ? getEvaluationScore(currentRankEntry, targetUseCase, currentModel, capabilityField) : (currentModel.capabilities?.[capabilityField] || 0);
    const currentCost = calculateModelCost(currentModel, monthlyTokens, inputRatio);

    // 3. Map alternatives
    let alternatives = [];
    if (rankData.length > 0) {
      for (const item of rankData) {
        if (!item.slug) continue;
        
        let dbModel = allModels.find(m => m._id.split('/')[1] === item.slug);
        if (!dbModel) {
          dbModel = allModels.find(m => m._id.toLowerCase().includes(item.slug.toLowerCase()) || item.slug.toLowerCase().includes(m._id.toLowerCase().split('/')[1] || ''));
        }
        
        if (dbModel && dbModel.endpoints && dbModel.endpoints.length > 0) {
          // De-duplicate: skip if this model is already mapped in alternatives
          if (alternatives.some(alt => alt._id === dbModel._id)) {
            continue;
          }

          const cost = calculateModelCost(dbModel, monthlyTokens, inputRatio);
          const score = getEvaluationScore(item, targetUseCase, dbModel, capabilityField);
          const valScore = cost > 0 ? (score / cost) : 0;
          
          alternatives.push({
            _id: dbModel._id,
            name: dbModel.name,
            developer: dbModel.developer,
            context_length: dbModel.context_length,
            performance_score: score,
            tokens_per_second: dbModel.capabilities?.tokens_per_second || 0,
            time_to_first_token_ms: dbModel.capabilities?.time_to_first_token_ms || 0,
            cost_per_m_input: dbModel.endpoints[0].input_cost_per_m,
            cost_per_m_output: dbModel.endpoints[0].output_cost_per_m,
            cache_read_cost_per_m: dbModel.endpoints[0].cache_read_cost_per_m || 0,
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
            name: m.name,
            developer: m.developer,
            context_length: m.context_length,
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

    const bestCategoryScore = Math.max(...alternatives.map(alt => alt.performance_score), currentScore) || 100;
    const qualityThreshold = parseFloat(req.body.qualityThreshold) || 90; // Default to 90% quality threshold

    // Apply filtering and compute recommendation score
    let filteredAlternatives = [];
    if (optimizationGoal === 'performance') {
      // Mode 1: Performance Preservation
      filteredAlternatives = alternatives.filter(alt => alt.performance_score >= currentScore && alt.monthly_cost < currentCost && alt._id !== currentModelId);
      filteredAlternatives.forEach(alt => {
        const qualityScore = alt.performance_score / bestCategoryScore;
        const costEfficiency = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
        alt.recommendation_score = 0.80 * qualityScore + 0.20 * costEfficiency;
      });
    } else if (optimizationGoal === 'cost') {
      // Mode 2: Target Cost Reduction
      const maxAllowedCost = currentCost * (1 - (costCutPercentage / 100));
      filteredAlternatives = alternatives.filter(alt => 
        alt.monthly_cost <= maxAllowedCost && 
        alt.performance_score >= currentScore * (qualityThreshold / 100) && 
        alt._id !== currentModelId
      );
      filteredAlternatives.forEach(alt => {
        const qualityScore = alt.performance_score / bestCategoryScore;
        const savingsScore = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
        alt.recommendation_score = 0.70 * savingsScore + 0.30 * qualityScore;
      });
    } else if (optimizationGoal === 'quality') {
      // Mode 3: Quality Focus
      if (rankData && rankData.length > 0) {
        // Recommend according to rank in the loaded category file (e.g. math.json)
        filteredAlternatives = alternatives.filter(alt => alt._id !== currentModelId);
        filteredAlternatives.forEach(alt => {
          // Smaller category_rank is better (Rank 1 is best)
          // Cost efficiency is secondary to resolve ties
          const costEfficiency = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
          alt.recommendation_score = (10000 - alt.category_rank) * 10 + costEfficiency;
        });
      } else {
        // Fallback to performance_score if no rank data is available
        filteredAlternatives = alternatives.filter(alt => (alt.performance_score > currentScore || (alt.performance_score === currentScore && alt.monthly_cost < currentCost)) && alt._id !== currentModelId);
        filteredAlternatives.forEach(alt => {
          const qualityScore = alt.performance_score / bestCategoryScore;
          const costEfficiency = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
          alt.recommendation_score = qualityScore * 1000 + costEfficiency;
        });
      }
    } else {
      // Fallback: Mode 1 (Performance Preservation)
      filteredAlternatives = alternatives.filter(alt => alt.performance_score >= currentScore && alt.monthly_cost < currentCost && alt._id !== currentModelId);
      filteredAlternatives.forEach(alt => {
        const qualityScore = alt.performance_score / bestCategoryScore;
        const costEfficiency = currentCost > 0 ? (currentCost - alt.monthly_cost) / currentCost : 0;
        alt.recommendation_score = 0.80 * qualityScore + 0.20 * costEfficiency;
      });
    }

    // Sort by recommendation score descending
    filteredAlternatives.sort((a, b) => b.recommendation_score - a.recommendation_score);

    // Limit to top 5
    const topAlternatives = filteredAlternatives.slice(0, 5);

    // 4. Construct reports
    const recommendations = topAlternatives.map(alt => {
      const savings = currentCost - alt.monthly_cost;
      const performanceRetained = (alt.performance_score / currentScore) * 100;

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
// Route to fetch raw Artificial Analysis API data for the home page analysis dashboard
router.get('/analysis/raw-data', (req, res) => {
  try {
    const rawPath = path.join(__dirname, '../data/raw_data.json');
    if (!fs.existsSync(rawPath)) {
      return res.status(404).json({ error: 'Raw analysis data not found. Please run database synchronization first.' });
    }

    const rawContent = fs.readFileSync(rawPath, 'utf8');
    const rawData = JSON.parse(rawContent);
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

      return {
        slug: item.slug,
        name: item.name,
        creator: item.model_creator?.name || 'Unknown',
        release_date: item.release_date,
        intelligence_index: parseFloat(evaluations.artificial_analysis_intelligence_index) || null,
        coding_index: parseFloat(evaluations.artificial_analysis_coding_index) || null,
        math_index: parseFloat(evaluations.artificial_analysis_math_index) || null,
        gpqa: parseFloat(evaluations.gpqa) || null,
        hle: parseFloat(evaluations.hle) || null,
        throughput: parseFloat(item.median_output_tokens_per_second) || null,
        ttft: parseFloat(item.median_time_to_first_token_seconds) || null,
        inputCost,
        outputCost,
        blendedPrice
      };
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

// Route to get list of all models for dropdown baselines
router.get('/models/list', async (req, res) => {
  try {
    const allModels = await Model.find({}).sort({ name: 1 });

    // Format models
    const formatted = allModels.map(m => ({
      id: m._id,
      name: m.name || m._id
    }));

    // Sort alphabetically by name
    formatted.sort((a, b) => a.name.localeCompare(b.name));

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

  const geminiKey = process.env.Gemini_Api_key;
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
    const axios = require('axios');
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

module.exports = router;
