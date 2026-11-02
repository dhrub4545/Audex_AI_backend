const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Audit = require('../models/Audit');
const User = require('../models/User');
const Model = require('../models/Model');
const { auth, optionalAuth } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getRawData, getRankCategory, getSubscriptionTiers, saveSubscriptionTiers } = require('../services/rankStorage');
const { runDailyRankingPipeline } = require('../services/dailyRankingPipeline');
const { syncSubscriptionTiers, isDiscontinuedModel, getModelRecencyScore } = require('../services/subscriptionTierSync');

const cache = require('../services/cacheService');

function round1(val) {
  if (val === null || val === undefined || isNaN(val)) return null;
  return Math.round(Number(val) * 10) / 10;
}

function round2(val) {
  if (val === null || val === undefined || isNaN(val)) return null;
  return Math.round(Number(val) * 100) / 100;
}

// Multi-tier model cache for high performance (L1 Memory + L2 Redis)
async function getCachedAllModels() {
  return await cache.getOrSet('audex:models:all_docs', async () => {
    if (mongoose.connection.readyState === 1) {
      try {
        const docs = await Model.find({}).lean();
        if (docs && docs.length > 0) return docs;
      } catch (_) {}
    }
    try {
      const rawPath = path.join(__dirname, '../data/raw_data.json');
      if (fs.existsSync(rawPath)) {
        const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
        const sources = raw.sources || {};
        const llms = Array.isArray(sources.llms) ? sources.llms : (sources.llms?.data || []);
        if (llms && llms.length > 0) {
          return llms.map(item => {
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
            const modelId = cleanSlug.includes('/') ? cleanSlug : `${creatorSlug}/${cleanSlug}`;

            const rawIntel = parseFloat(evaluations.artificial_analysis_intelligence_index);
            const rawCoding = parseFloat(evaluations.artificial_analysis_coding_index ?? evaluations.livecodebench);
            const rawMath = parseFloat(evaluations.artificial_analysis_math_index ?? evaluations.aime);
            const rawReason = parseFloat(evaluations.gpqa ?? evaluations.hle);

            return {
              _id: item.modelId || modelId,
              slug: item.slug,
              name: item.name,
              developer: creatorName,
              context_length: item.context_length || null,
              endpoints: [{
                input_cost_per_m: inputCost,
                output_cost_per_m: outputCost,
                cache_read_cost_per_m: 0
              }],
              capabilities: {
                aa_index_score: !isNaN(rawIntel) && rawIntel > 0 ? round1(rawIntel) : null,
                coding_score: !isNaN(rawCoding) && rawCoding > 0 ? round1(rawCoding <= 1 ? rawCoding * 100 : rawCoding) : null,
                reasoning_score: !isNaN(rawReason) && rawReason > 0 ? round1(rawReason <= 1 ? rawReason * 100 : rawReason) : null,
                math_score: !isNaN(rawMath) && rawMath > 0 ? round1(rawMath <= 1 ? rawMath * 100 : rawMath) : null,
                tokens_per_second: item.median_output_tokens_per_second ? parseFloat(item.median_output_tokens_per_second) : null,
                time_to_first_token_ms: item.median_time_to_first_token_seconds ? Math.round(item.median_time_to_first_token_seconds * 1000) : null
              },
              evaluations: evaluations,
              pricing: item.pricing || { price_1m_input_tokens: inputCost, price_1m_output_tokens: outputCost }
            };
          });
        }
      }
    } catch (_) {}
    return [];
  }, 600); // 10 minutes TTL
}

// Fallback report generator for Model Comparison
function generateFallbackCompareReport(baseline, recommended) {
  const baseInput = baseline.cost_per_m_input ?? baseline.pricing?.price_1m_input_tokens ?? 3;
  const baseOutput = baseline.cost_per_m_output ?? baseline.pricing?.price_1m_output_tokens ?? 15;
  const recInput = recommended.cost_per_m_input ?? recommended.pricing?.price_1m_input_tokens ?? 0.5;
  const recOutput = recommended.cost_per_m_output ?? recommended.pricing?.price_1m_output_tokens ?? 1.5;
  
  const inputSavingsPct = baseInput > 0 ? Math.max(0, Math.round(((baseInput - recInput) / baseInput) * 100)) : 0;
  const outputSavingsPct = baseOutput > 0 ? Math.max(0, Math.round(((baseOutput - recOutput) / baseOutput) * 100)) : 0;
  const avgSavingsPct = Math.max(0, Math.round((inputSavingsPct + outputSavingsPct) / 2));
  
  const recSpeed = recommended.tokens_per_second ?? recommended.throughput ?? '110+';

  return {
    architectural_insight: {
      title: '🧠 Architectural Spend Decision Insight',
      paragraphs: [
        'Transitioning from ' + baseline.name + ' to ' + recommended.name + ' offers substantial cost and operational efficiencies. With ' + recommended.name + ' priced at $' + recInput + '/1M input and $' + recOutput + '/1M output compared to ' + baseline.name + ' ($' + baseInput + '/1M input and $' + baseOutput + '/1M output), your workload achieves an estimated ' + avgSavingsPct + '% direct unit token cost reduction.',
        'Beyond raw pricing, ' + recommended.name + ' delivers high inference throughput (' + recSpeed + ' tokens/sec), preserving capability thresholds for production workloads while slashing AI API budget overhead.'
      ],
      quality_analysis_box: 'Quality Analysis: ' + recommended.name + ' retains approximately ' + (recommended.coding_index && baseline.coding_index ? Math.round((recommended.coding_index / baseline.coding_index) * 100) : 92) + '% of baseline capability while running on an optimized inference route.'
    },
    route_migration_checklist: {
      title: '🚀 Route Migration Checklist',
      steps: [
        {
          bold_text: 'API Credentials',
          detail: 'Configure your API key for ' + (recommended.creator || recommended.developer || 'the recommended provider') + ' in your secure environment variables.'
        },
        {
          bold_text: 'Model Parameter Target',
          detail: 'Set the target model ID parameter in your SDK configuration to "' + (recommended.modelId || recommended.name) + '".'
        },
        {
          bold_text: 'Fallback Routing Buffer',
          detail: 'Implement retry routers to gracefully fall back to ' + baseline.name + ' if rate limits or latency thresholds are exceeded.'
        },
        {
          bold_text: 'Telemetry & Cost Monitoring',
          detail: 'Establish prompt-level token logging to monitor realized spend reductions across production traffic.'
        }
      ],
      migration_script: '// Node.js / Python SDK migration example\nconst client = new AIClient({ apiKey: process.env.RECOMMENDED_API_KEY });\n\nconst response = await client.chat.completions.create({\n  model: "' + (recommended.modelId || 'recommended-model') + '",\n  messages: [{ role: "user", content: prompt }],\n  temperature: 0.7\n});'
    }
  };
}


// Load subscription pricing tiers from JSON file or rankStorage
let subscriptionTiers = [];
try {
  const tiersPath = path.join(__dirname, '../data/subscription_tiers.json');
  if (fs.existsSync(tiersPath)) {
    subscriptionTiers = JSON.parse(fs.readFileSync(tiersPath, 'utf8'));
  }
} catch (err) {
  console.error('Error loading subscription_tiers.json:', err);
}

async function refreshSubscriptionTiers() {
  try {
    const tiers = await getSubscriptionTiers();
    if (tiers && tiers.length > 0) subscriptionTiers = tiers;
  } catch (_) {}
}
refreshSubscriptionTiers().catch(() => {});

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

// Finds the top-ranked model of a subscription tier for a specific category
function findTopModelOfSubscription(tier, rankData, allModels, purpose = 'mixed') {
  if (!tier) return null;
  const models = tier.models || [];
  const rawModels = tier.rawModels || [];
  let bestEntry = null;
  let bestModel = null;
  let bestScore = null;
  let bestRank = 99999;

  for (const mid of models) {
    if (isDiscontinuedModel(mid)) continue;
    const slug = mid.includes('/') ? mid.split('/')[1] : mid;
    const entry = findRankEntry(rankData, slug, mid);
    const dbModel = allModels?.find(m => m._id === mid || (m._id && m._id.toLowerCase() === mid.toLowerCase()) || (m._id && m._id.split('/')[1] === slug));
    const score = getEvaluationScore(entry, purpose, dbModel, 'aa_index_score');
    const rank = entry && typeof entry.rank === 'number' && entry.rank > 0 ? entry.rank : 99999;
    
    const isBetter = (rank < bestRank) || 
      (rank === bestRank && score !== null && (bestScore === null || score > bestScore)) || 
      (bestRank === 99999 && score !== null && (bestScore === null || score > bestScore));

    if (isBetter) {
      bestScore = score;
      bestRank = rank;
      bestEntry = entry;
      bestModel = dbModel || (entry ? {
        _id: entry.modelId || mid,
        name: entry.name,
        developer: entry.organization || tier.provider,
        endpoints: entry.pricing ? [{
          input_cost_per_m: entry.pricing.price_1m_input_tokens || 0,
          output_cost_per_m: entry.pricing.price_1m_output_tokens || 0
        }] : []
      } : dbModel);
    }
  }

  // Also check rawModels names if models list did not resolve
  if (rawModels.length > 0) {
    for (const rm of rawModels) {
      if (isDiscontinuedModel(rm)) continue;
      const entry = rankData?.find(m => m.name && (m.name.toLowerCase().includes(rm.toLowerCase()) || rm.toLowerCase().includes(m.name.toLowerCase())));
      if (entry) {
        const dbModel = allModels?.find(m => m.name && m.name.toLowerCase() === entry.name.toLowerCase());
        const score = getEvaluationScore(entry, purpose, dbModel, 'aa_index_score');
        const rank = entry && typeof entry.rank === 'number' && entry.rank > 0 ? entry.rank : 99999;
        const isBetter = (rank < bestRank) || 
          (rank === bestRank && score !== null && (bestScore === null || score > bestScore)) || 
          (bestRank === 99999 && score !== null && (bestScore === null || score > bestScore));

        if (isBetter) {
          bestScore = score;
          bestRank = rank;
          bestEntry = entry;
          bestModel = dbModel || {
            _id: entry.modelId || `unknown/${entry.slug}`,
            name: entry.name,
            developer: entry.organization || tier.provider
          };
        }
      }
    }
  }

  // Fallback to the first available non-discontinued model in the tier if none matched rankData
  const activeRaw = (rawModels || []).filter(m => !isDiscontinuedModel(m));
  const activeMid = (models || []).filter(m => !isDiscontinuedModel(m));
  if (!bestModel && (activeRaw.length > 0 || activeMid.length > 0)) {
    const firstRaw = activeRaw[0];
    const firstMid = activeMid[0];
    const dbModel = allModels?.find(m => 
      (firstMid && (m._id === firstMid || m._id.toLowerCase() === firstMid.toLowerCase())) || 
      (firstRaw && m.name && m.name.toLowerCase() === firstRaw.toLowerCase())
    );
    bestModel = dbModel || {
      _id: firstMid || `custom/${(firstRaw || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: firstRaw || firstMid || 'Model',
      developer: tier.provider,
      endpoints: []
    };
    if (bestScore === null) bestScore = 75;
    if (bestRank === 99999) bestRank = 50;
  }

  return {
    model: bestModel,
    rankEntry: bestEntry,
    rank: bestRank !== 99999 ? bestRank : 999,
    score: bestScore
  };
}

function getRankFileName(purpose) {
  const p = purpose ? purpose.toLowerCase().trim().replace(/\s+/g, '-') : 'mixed';
  if (p === 'coding') return 'coding.json';
  if (p === 'writing' || p === 'creative-writing') return 'creative-writing.json';
  if (p === 'research') return 'research.json';
  if (p === 'math') return 'math.json';
  if (p === 'reasoning') return 'reasoning.json';
  if (p === 'instruction' || p === 'instruction-following') return 'instruction-following.json';
  if (p === 'data' || p === 'data-analysis') return 'data-analysis.json';
  if (p === 'agents') return 'agents.json';
  if (p === 'fast') return 'fast.json';
  if (p === 'cheap') return 'cheap.json';
  if (p === 'knowledge') return 'knowledge.json';
  if (p === 'vision') return 'vision.json';
  if (p === 'multilingual') return 'multilingual.json';
  if (p === 'frontier') return 'frontier.json';
  
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

const rankCategoryMemoryCache = new Map();

function getCategoryRankData(purpose) {
  const normPurpose = (purpose || 'mixed').toLowerCase().trim();
  if (rankCategoryMemoryCache.has(normPurpose)) {
    return rankCategoryMemoryCache.get(normPurpose);
  }
  const filename = getRankFileName(purpose);
  const catKey = filename.replace('.json', '');

  // 1. Check raw_data.json categories first for specific category
  try {
    const rawPath = path.join(__dirname, '../data/raw_data.json');
    if (fs.existsSync(rawPath)) {
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      if (raw.categories && Array.isArray(raw.categories[catKey]) && raw.categories[catKey].length > 0) {
        rankCategoryMemoryCache.set(normPurpose, raw.categories[catKey]);
        return raw.categories[catKey];
      }
    }
  } catch (_) {}

  // 2. Check local data/rank directory for specific category file
  const filePath = path.join(__dirname, '../data/rank', filename);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        rankCategoryMemoryCache.set(normPurpose, data);
        return data;
      }
    } catch (e) {
      console.error(`Error reading rank file ${filename}:`, e);
    }
  }

  // 3. Fallback to raw_data.json overall ONLY if specific category file does not exist
  try {
    const rawPath = path.join(__dirname, '../data/raw_data.json');
    if (fs.existsSync(rawPath)) {
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      if (raw.categories && Array.isArray(raw.categories['overall']) && raw.categories['overall'].length > 0) {
        rankCategoryMemoryCache.set(normPurpose, raw.categories['overall']);
        return raw.categories['overall'];
      }
    }
  } catch (_) {}

  return [];
}

function getEvaluationScore(item, purpose, dbModel, capabilityField) {
  if (!item && !dbModel) return null;

  const evals = item?.evaluations || dbModel?.evaluations || {};
  const p = purpose ? purpose.toLowerCase() : 'mixed';

  // 1. Category-specific verified actual benchmarks
  if (p === 'coding') {
    if (typeof evals.livecodebench === 'number' && evals.livecodebench > 0) {
      return round1(evals.livecodebench <= 1 ? evals.livecodebench * 100 : evals.livecodebench);
    }
    if (typeof evals.artificial_analysis_coding_index === 'number' && evals.artificial_analysis_coding_index > 0) {
      return round1(evals.artificial_analysis_coding_index);
    }
    if (typeof evals.terminalbench_v2_1 === 'number' && evals.terminalbench_v2_1 > 0) {
      return round1(evals.terminalbench_v2_1 <= 1 ? evals.terminalbench_v2_1 * 100 : evals.terminalbench_v2_1);
    }
    if (typeof evals.coding_agent_index === 'number' && evals.coding_agent_index > 0) {
      return round1(evals.coding_agent_index);
    }
    if (typeof evals.scicode === 'number' && evals.scicode > 0) {
      return round1(evals.scicode <= 1 ? evals.scicode * 100 : evals.scicode);
    }
    if (typeof item?.category_scores?.coding === 'number' && item.category_scores.coding > 0) {
      return round1(item.category_scores.coding);
    }
    if (typeof dbModel?.capabilities?.coding_score === 'number' && dbModel.capabilities.coding_score > 0) {
      return round1(dbModel.capabilities.coding_score);
    }
    return null;
  }

  if (p === 'math') {
    if (typeof evals.aime === 'number' && evals.aime > 0) {
      return round1(evals.aime <= 1 ? evals.aime * 100 : evals.aime);
    }
    if (typeof evals.artificial_analysis_math_index === 'number' && evals.artificial_analysis_math_index > 0) {
      return round1(evals.artificial_analysis_math_index);
    }
    if (typeof evals.scicode === 'number' && evals.scicode > 0) {
      return round1(evals.scicode <= 1 ? evals.scicode * 100 : evals.scicode);
    }
    if (typeof item?.category_scores?.math === 'number' && item.category_scores.math > 0) {
      return round1(item.category_scores.math);
    }
    if (typeof dbModel?.capabilities?.math_score === 'number' && dbModel.capabilities.math_score > 0) {
      return round1(dbModel.capabilities.math_score);
    }
    return null;
  }

  if (p === 'reasoning') {
    if (typeof evals.gpqa === 'number' && evals.gpqa > 0) {
      return round1(evals.gpqa <= 1 ? evals.gpqa * 100 : evals.gpqa);
    }
    if (typeof evals.hle === 'number' && evals.hle > 0) {
      return round1(evals.hle <= 1 ? evals.hle * 100 : evals.hle);
    }
    if (typeof evals.artificial_analysis_intelligence_index === 'number' && evals.artificial_analysis_intelligence_index > 0) {
      return round1(evals.artificial_analysis_intelligence_index);
    }
    if (typeof item?.category_scores?.reasoning === 'number' && item.category_scores.reasoning > 0) {
      return round1(item.category_scores.reasoning);
    }
    if (typeof dbModel?.capabilities?.reasoning_score === 'number' && dbModel.capabilities.reasoning_score > 0) {
      return round1(dbModel.capabilities.reasoning_score);
    }
    return null;
  }

  if (p === 'research') {
    if (typeof evals.hle === 'number' && evals.hle > 0) {
      return round1(evals.hle <= 1 ? evals.hle * 100 : evals.hle);
    }
    if (typeof evals.lcr === 'number' && evals.lcr > 0) {
      return round1(evals.lcr <= 1 ? evals.lcr * 100 : evals.lcr);
    }
    if (typeof evals.gpqa === 'number' && evals.gpqa > 0) {
      return round1(evals.gpqa <= 1 ? evals.gpqa * 100 : evals.gpqa);
    }
    if (typeof item?.category_scores?.research === 'number' && item.category_scores.research > 0) {
      return round1(item.category_scores.research);
    }
    return null;
  }

  if (p === 'instruction' || p === 'instruction-following') {
    if (typeof evals.ifbench === 'number' && evals.ifbench > 0) {
      return round1(evals.ifbench <= 1 ? evals.ifbench * 100 : evals.ifbench);
    }
    if (typeof item?.category_scores?.instruction === 'number' && item.category_scores.instruction > 0) {
      return round1(item.category_scores.instruction);
    }
    return null;
  }

  // 2. Direct overall intelligence index
  if (typeof evals.artificial_analysis_intelligence_index === 'number' && evals.artificial_analysis_intelligence_index > 0) {
    return round1(evals.artificial_analysis_intelligence_index);
  }

  // 3. Database capability score if specified
  const dbScore = dbModel?.capabilities?.[capabilityField];
  if (typeof dbScore === 'number' && dbScore > 0) {
    return round1(dbScore);
  }

  // 4. Actual Arena Elo / rating / final_score from category files
  if (typeof item?.final_score === 'number' && item.final_score > 0) {
    return round1(item.final_score);
  }
  if (typeof item?.rating === 'number' && item.rating > 0) {
    return round1(item.rating);
  }
  if (typeof item?.arena_elo === 'number' && item.arena_elo > 0) {
    return round1(item.arena_elo);
  }

  return null;
}

function findRankEntry(rankData, baselineSlug, baselineModelId, baselineName) {
  if (!rankData || rankData.length === 0) return null;
  const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetClean = clean(baselineSlug);
  const modelIdClean = clean(baselineModelId);
  const nameClean = clean(baselineName);

  // 1. Try exact modelId match if item has modelId
  if (baselineModelId) {
    let match = rankData.find(item => item.modelId && (item.modelId.toLowerCase() === baselineModelId.toLowerCase() || clean(item.modelId) === modelIdClean));
    if (match) return match;
  }

  // 2. Try match by model name if provided
  if (baselineName) {
    let match = rankData.find(item => item.name && (item.name.toLowerCase() === baselineName.toLowerCase() || clean(item.name) === nameClean));
    if (match) return match;
  }

  // 3. Try exact match by slug
  if (baselineSlug) {
    let match = rankData.find(item => item.slug === baselineSlug);
    if (match) return match;

    // 4. Try exact clean match
    match = rankData.find(item => clean(item.slug || '') === targetClean);
    if (match) return match;

    // 5. Try clean substring match
    match = rankData.find(item => {
      const itemClean = clean(item.slug || '');
      return (itemClean && targetClean) && (itemClean.includes(targetClean) || targetClean.includes(itemClean));
    });
    if (match) return match;
  }

  // 6. Substring match by name
  if (nameClean && nameClean.length >= 4) {
    let match = rankData.find(item => {
      const itemClean = clean(item.name || '');
      return (itemClean && nameClean) && (itemClean.includes(nameClean) || nameClean.includes(itemClean));
    });
    if (match) return match;
  }

  return null;
}

// Shared helper to calculate cost
function calculateModelCost(model, tokens, ratio) {
  const endpoint = model?.endpoints?.[0];
  const inPrice = endpoint?.input_cost_per_m ?? model?.pricing?.price_1m_input_tokens ?? 0;
  const outPrice = endpoint?.output_cost_per_m ?? model?.pricing?.price_1m_output_tokens ?? 0;
  const inputTokens = tokens * ratio;
  const outputTokens = tokens * (1 - ratio);
  const inputCost = (inputTokens / 1000000) * inPrice;
  const outputCost = (outputTokens / 1000000) * outPrice;
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

    const uniqueTools = [...new Set(allocations.map(a => a.toolName))];
    const numTools = uniqueTools.length;
    let tierUsed = numTools > 15 ? 'proMax' : (numTools > 2 ? 'pro' : 'starter');

    const docs = await getCachedAllModels();
    const allModels = docs.map(d => d.toObject ? d.toObject() : d);

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

        const rankData = getCategoryRankData(purpose);
        const topSub = findTopModelOfSubscription(tier, rankData, allModels, purpose);

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
          const currentRankEntry = findRankEntry(rankData, currentSlug, currentModel._id, currentModel.name);
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
    });

    // Inject currentCost, baselineModelId, topModelId, and baselineModels into parsedAllocations so the frontend can read it
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

    allocationDetails.forEach((detail) => {
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

      const rankData = getCategoryRankData(purpose);

      // Resolve the API model for this allocation (needed for both baseline calc and target model below)
      const currentModel = (type === 'api' && modelId)
        ? (allModels.find(m => m._id === modelId) ||
           allModels.find(m => m._id && m._id.toLowerCase().includes(modelId.toLowerCase())))
        : null;

      // Determine baseline rank and score
      let baselineRank = null;
      let computedBaselineScore = baselineScore;

      if (type === 'subscription') {
        const matchingTier = findSubscriptionTier(toolName, plan);
        const topSub = findTopModelOfSubscription(matchingTier, rankData, allModels, purpose);
        if (topSub && topSub.rankEntry) {
          baselineRank = (typeof topSub.rank === 'number' && topSub.rank < 9999) ? topSub.rank : null;
          computedBaselineScore = topSub.score;
          if (topSub.model) {
            primaryBaselineModel = topSub.model;
          }
        }
      } else {
        // api
        if (currentModel) {
          const currentSlug = currentModel._id.split('/')[1] || '';
          const rankEntry = findRankEntry(rankData, currentSlug, currentModel._id, currentModel.name);
          if (rankEntry) {
            baselineRank = (typeof rankEntry.rank === 'number' && rankEntry.rank > 0) ? rankEntry.rank : (parseInt(rankEntry.rank) || null);
            computedBaselineScore = getEvaluationScore(rankEntry, purpose, currentModel, capabilityField);
          } else {
            computedBaselineScore = currentModel.capabilities?.[capabilityField] || null;
          }
        }
      }

      // OPTION A: Best Model API Candidates
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
          const contextLength = dbModel?.context_length || null;
          const contextStr = contextLength ? (contextLength >= 1000000 ? `${(contextLength / 1000000).toFixed(0)}M` : `${(contextLength / 1000).toFixed(0)}K`) : 'N/A';
          const limitsStr = `Pay-as-you-go rates: $${inP.toFixed(2)}/1M input, $${outP.toFixed(2)}/1M output. Context: ${contextStr}.`;

          apiCandidates.push({
            _id: candidateId,
            name: item.name || dbModel?.name,
            rank: (typeof item.rank === 'number' && item.rank > 0) ? item.rank : (parseInt(item.rank) || 999),
            performance_score: score,
            monthly_cost: cost,
            isCurrent: (candidateId === modelId) || (dbModel && dbModel._id === modelId),
            limits: limitsStr,
            context_length: contextLength,
            inputCostPerM: inP,
            outputCostPerM: outP
          });
        }
      } else {
        apiCandidates = allModels
          .filter(m => {
            if (!m.endpoints || m.endpoints.length === 0) return false;
            const ep = m.endpoints[0];
            return (ep.input_cost_per_m || 0) > 0 && (ep.output_cost_per_m || 0) > 0;
          })
          .map((m, idx) => {
            const cost = calculateModelCost(m, totalTokens, inputRatio);
            const score = m.capabilities?.[capabilityField] || null;
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
        let compatible = apiCandidates.filter(c => !c.isCurrent);
        compatible.sort((a, b) => a.rank - b.rank);
        selectedApi = compatible[0] || null;
      } else if (optimizationGoal === 'performance') {
        let compatible = apiCandidates.filter(c => {
          if (c.isCurrent) return false;
          if (c.monthly_cost >= currentCost) return false;
          if (baselineRank !== null && c.rank >= baselineRank) return false;
          if (computedBaselineScore !== null && c.performance_score !== null && c.performance_score < computedBaselineScore) return false;
          return true;
        });
        compatible.sort((a, b) => (a.rank - b.rank) || (a.monthly_cost - b.monthly_cost));
        selectedApi = compatible[0] || null;
        if (!selectedApi) {
          apiStatusText = "Already optimized in this category.";
        }
      } else if (optimizationGoal === 'cost') {
        const maxAllowedCost = currentCost * (1 - costCutPercentage / 100);
        let compatible = apiCandidates.filter(c => !c.isCurrent && c.monthly_cost <= maxAllowedCost);
        compatible.sort((a, b) => (a.rank - b.rank) || (a.monthly_cost - b.monthly_cost));
        selectedApi = compatible[0] || null;
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
      } else if (primaryBaselineModel) {
        targetModelId = primaryBaselineModel._id;
        targetModelName = primaryBaselineModel.name;
        targetModelDev = primaryBaselineModel.developer;
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
        const topSub = findTopModelOfSubscription(t, rankData, allModels, purpose);
        const bestRank = topSub ? topSub.rank : 999;
        const bestScore = topSub ? topSub.score : null;

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

      if (optimizationGoal === 'quality') {
        let compatible = subCandidates.filter(c => !c.isCurrent);
        compatible.sort((a, b) => (a.rank - b.rank) || (a.cost - b.cost));
        selectedSub = compatible[0] || null;
      } else if (optimizationGoal === 'performance') {
        let compatible = subCandidates.filter(c => {
          if (c.isCurrent) return false;
          if (c.cost >= currentCost) return false;
          if (baselineRank !== null && c.rank >= baselineRank) return false;
          if (computedBaselineScore !== null && c.performance_score !== null && c.performance_score < computedBaselineScore) return false;
          return true;
        });
        compatible.sort((a, b) => (a.rank - b.rank) || (a.cost - b.cost));
        selectedSub = compatible[0] || null;
        if (!selectedSub) {
          subStatusText = "Already optimized in this category.";
        }
      } else if (optimizationGoal === 'cost') {
        const maxAllowedCost = currentCost * (1 - costCutPercentage / 100);
        let compatible = subCandidates.filter(c => !c.isCurrent && c.cost <= maxAllowedCost);
        compatible.sort((a, b) => (a.rank - b.rank) || (a.cost - b.cost));
        selectedSub = compatible[0] || null;
      }

      // Build structured Options
      const apiOption = selectedApi ? {
        cost: selectedApi.monthly_cost,
        savings: currentCost - selectedApi.monthly_cost,
        name: selectedApi.name,
        modelId: selectedApi._id,
        performance_score: selectedApi.performance_score,
        category_rank: selectedApi.rank,
        action: (type === 'api' && selectedApi.isCurrent)
          ? "Your current model API is already the best choice. Keep using it."
          : `Transition active users to direct API keys using ${selectedApi.name}.`,
        statusText: (type === 'api' && selectedApi.isCurrent) ? (apiStatusText || "Optimized") : "",
        alreadyOptimized: false,
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
        name: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Current Model"),
        modelId: modelId,
        performance_score: computedBaselineScore,
        category_rank: baselineRank,
        action: (type === 'api')
          ? "Your current model API is already the best choice. Keep using it."
          : `Your current configuration is already optimized.`,
        statusText: "Already optimized in this category.",
        alreadyOptimized: true,
        limits: primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints.length > 0
          ? `Pay-as-you-go rates: $${primaryBaselineModel.endpoints[0].input_cost_per_m.toFixed(2)}/1M input, $${primaryBaselineModel.endpoints[0].output_cost_per_m.toFixed(2)}/1M output. Context: ${primaryBaselineModel.context_length ? (primaryBaselineModel.context_length >= 1000000 ? `${(primaryBaselineModel.context_length / 1000000).toFixed(0)}M` : `${(primaryBaselineModel.context_length / 1000).toFixed(0)}K`) : 'N/A'}.`
          : "Pay-as-you-go token consumption limits.",
        includedModels: primaryBaselineModel ? [primaryBaselineModel.name] : (modelId ? [modelId] : []),
        recommendedModel: primaryBaselineModel ? primaryBaselineModel.name : (modelId || "Current Model"),
        recommendedProvider: primaryBaselineModel ? getCleanProviderName(primaryBaselineModel._id.split('/')[0]) : getCleanProviderName(toolName),
        inputCostPerM: (primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints[0]) ? (primaryBaselineModel.endpoints[0].input_cost_per_m || 0) : 0,
        outputCostPerM: (primaryBaselineModel && primaryBaselineModel.endpoints && primaryBaselineModel.endpoints[0]) ? (primaryBaselineModel.endpoints[0].output_cost_per_m || 0) : 0,
        defaultInputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 10000000 : 5000000)) : inputTokens,
        defaultOutputTokens: (type === 'subscription') ? (seats * (purpose === 'Coding' ? 2500000 : 1250000)) : outputTokens
      };

      const recommendedSubTopModel = selectedSub?.topModel || (selectedSub?.tier ? findTopModelOfSubscription(selectedSub.tier, rankData, allModels, purpose)?.model : null);
      const subFormattedPlan = selectedSub?.tier ? formatSubscriptionPlanName(selectedSub.tier.provider, selectedSub.tier.plan) : '';
      const fallbackFormattedPlan = formatSubscriptionPlanName(toolName, plan || "Free");
      const subscriptionOption = selectedSub ? {
        planName: subFormattedPlan,
        cost: selectedSub.cost,
        savings: currentCost - selectedSub.cost,
        limits: selectedSub.tier.limits,
        includedModels: selectedSub.tier.rawModels || [],
        modelId: recommendedSubTopModel ? recommendedSubTopModel._id : (selectedSub.tier.models?.[0] || null),
        topModelId: recommendedSubTopModel ? recommendedSubTopModel._id : null,
        topModelName: recommendedSubTopModel ? recommendedSubTopModel.name : null,
        category_rank: selectedSub.rank,
        performance_score: selectedSub.performance_score,
        action: (type === 'subscription' && selectedSub.isCurrent)
          ? "Your current subscription is already the best choice. Keep using it."
          : `Migrate to the ${subFormattedPlan} subscription.`,
        statusText: (type === 'subscription' && selectedSub.isCurrent) ? (subStatusText || "Optimized") : "",
        alreadyOptimized: false,
        recommendedModel: subFormattedPlan,
        recommendedProvider: getCleanProviderName(selectedSub.tier.provider)
      } : {
        planName: fallbackFormattedPlan,
        cost: currentCost,
        savings: 0,
        limits: tier ? tier.limits : "Free plan limits",
        includedModels: tier ? (tier.rawModels || []) : [],
        modelId: primaryBaselineModel ? primaryBaselineModel._id : (tier?.models?.[0] || null),
        topModelId: primaryBaselineModel ? primaryBaselineModel._id : null,
        topModelName: primaryBaselineModel ? primaryBaselineModel.name : null,
        category_rank: baselineRank,
        performance_score: computedBaselineScore,
        action: (type === 'subscription')
          ? "Your current subscription is already the best choice. Keep using it."
          : `Migrate to the ${fallbackFormattedPlan} subscription.`,
        statusText: "Already optimized in this category.",
        alreadyOptimized: true,
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
          modelName: currentModelName,
          baselineModels: (type === 'subscription' && detail.tier) ? (detail.tier.rawModels || []) : [],
          topModelId: detail.primaryBaselineModel ? detail.primaryBaselineModel._id : null,
          topModelName: detail.primaryBaselineModel ? detail.primaryBaselineModel.name : null
        }
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
      tierUsed: tierUsed,
      createdAt: new Date()
    };

    let returnedAudit = { ...auditData, _id: 'local_' + Date.now() };
    if (mongoose.connection.readyState === 1) {
      try {
        const audit = new Audit(auditData);
        await audit.save();
        console.log('Saved audit in MongoDB:', audit._id);
        returnedAudit = audit.toObject();
      } catch (saveErr) {
        console.warn('MongoDB save warning:', saveErr.message);
      }
    }
    returnedAudit.isUnlocked = true;

    return res.status(201).json({
      ...returnedAudit,
      totalCurrentCost: totalCurrentBudget,
      updatedCredits: user ? (user.credits || { starter: 999, pro: 999, proMax: 999 }) : null
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
    
    // Hydrate baselineModels for all audits returned in the list
    const auditsObj = audits.map(audit => {
      const auditObj = audit.toObject();
      auditObj.isUnlocked = true;
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
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    // Guard: Do not intercept named sub-routes
    const reservedWords = ['models', 'analysis', 'subscription-tiers', 'cron', 'cache', 'compare-report', 'audit-recommendation'];
    if (reservedWords.includes(id)) {
      return next();
    }
    if (!mongoose.Types.ObjectId.isValid(id) && id !== '6a4fb719471a97ae89e88f49') {
      return res.status(400).json({ error: 'Invalid audit ID format.' });
    }

    const cacheKey = `audex:audit:doc:${id}`;
    let auditObj = await cache.get(cacheKey);

    if (!auditObj) {
      const audit = await Audit.findById(id).lean();
      if (!audit) {
        return res.status(404).json({ error: 'Audit not found' });
      }
      auditObj = audit;
      await cache.set(cacheKey, auditObj, 300); // 5 minutes TTL
    }

    // Verify ownership (except for the sample audit)
    const isSampleAudit = id === '6a4fb719471a97ae89e88f49';
    if (!isSampleAudit && auditObj.userId) {
      const ownerId = auditObj.userId._id ? auditObj.userId._id.toString() : auditObj.userId.toString();
      if (!req.user || ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied. You do not own this audit report.' });
      }
    }

    // Create a mutable copy for response hydration
    auditObj = JSON.parse(JSON.stringify(auditObj));
      auditObj.isUnlocked = true;
    if (auditObj.allocations && Array.isArray(auditObj.allocations)) {
      auditObj.allocations.forEach((alloc, index) => {
        console.log(`[Hydration GET] alloc #${index}: type=${alloc.type}, toolName=${alloc.toolName}, plan=${alloc.plan}`);
        if (alloc.type === 'subscription' && (!alloc.baselineModels || alloc.baselineModels.length === 0)) {
          const tier = findSubscriptionTier(alloc.toolName, alloc.plan);
          console.log(`[Hydration GET] findSubscriptionTier resolved tier:`, tier ? tier.plan : 'null');
          alloc.baselineModels = tier ? (tier.rawModels || []) : [];
          console.log(`[Hydration GET] hydrated baselineModels:`, alloc.baselineModels);
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
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid audit ID format.' });
    }
    const audit = await Audit.findById(id);

    if (!audit) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    // Verify ownership
    if (audit.userId && audit.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You do not own this audit report.' });
    }

    await Audit.deleteOne({ _id: id });
    await cache.del(`audex:audit:doc:${id}`);
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
    await cache.del(`audex:audit:doc:${id}`);

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

    const recCacheKey = `audex:rec:${currentModelId}:${targetUseCase}:${monthlyTokens}:${inputRatio}:${optimizationGoal}:${costCutPercentage}`;
    const cachedRecommendation = await cache.get(recCacheKey);
    if (cachedRecommendation) {
      return res.json(cachedRecommendation);
    }

    const capabilityField = {
      'Coding': 'coding_score',
      'Writing': 'reasoning_score',
      'Math': 'math_score',
      'Research': 'reasoning_score',
      'Mixed': 'aa_index_score'
    }[targetUseCase] || 'aa_index_score';

    // 1. Fetch models (Multi-Tier Cached)
    let allModels = await getCachedAllModels();

    // If no models at all, try syncing first
    if (!allModels || allModels.length === 0) {
      console.log('🔄 Database is empty, auto-triggering local sync/seeding in recommendation route...');
      const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');
      await syncArtificialAnalysis();
      await cache.del('audex:models:all_docs');
      allModels = await getCachedAllModels();
    }

    if (allModels.length === 0) {
      return res.status(503).json({ error: 'Database is empty. Please wait for the initial synchronization pipeline to complete, or check backend logs.' });
    }



    // 2. Find current model
    let currentModel = allModels.find(m => m._id === currentModelId);
    if (!currentModel) {
      // Try fuzzy matching
      const targetBase = (currentModelId.split('/')[1] || currentModelId).toLowerCase();
      currentModel = allModels.find(m => m._id.toLowerCase().includes(targetBase) || (m.slug && m.slug.toLowerCase() === targetBase)) || null;
    }
    if (!currentModel) {
      const cleanStr = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const targetClean = cleanStr(currentModelId);
      currentModel = allModels.find(m => cleanStr(m._id) === targetClean || cleanStr(m.name || '') === targetClean || cleanStr(m.slug || '') === targetClean) || null;
    }
    if (!currentModel) {
      // Direct lookup from rankData/raw_data if DB didn't resolve it
      const rawRankData = getCategoryRankData(targetUseCase);
      const entry = findRankEntry(rawRankData, currentModelId.split('/')[1] || currentModelId, currentModelId);
      if (entry) {
        currentModel = {
          _id: entry.modelId || currentModelId,
          slug: entry.slug || currentModelId.split('/')[1] || currentModelId,
          name: entry.name,
          developer: entry.organization || 'AI Provider',
          context_length: null,
          endpoints: [{
            input_cost_per_m: entry.pricing?.price_1m_input_tokens || 0,
            output_cost_per_m: entry.pricing?.price_1m_output_tokens || 0
          }],
          capabilities: {
            tokens_per_second: entry.median_output_tokens_per_second || null,
            time_to_first_token_ms: entry.median_time_to_first_token_seconds ? Math.round(entry.median_time_to_first_token_seconds * 1000) : null
          }
        };
      }
    }
    if (!currentModel) {
      return res.status(404).json({ error: 'Baseline model data not found in database.' });
    }

    const rankData = getCategoryRankData(targetUseCase);
    
    const currentSlug = currentModel._id.split('/')[1] || '';
    const currentRankEntry = findRankEntry(rankData, currentSlug, currentModel._id, currentModel.name);
    const currentRank = currentRankEntry && typeof currentRankEntry.rank === 'number' && currentRankEntry.rank > 0 ? currentRankEntry.rank : (parseInt(currentRankEntry?.rank) || null);
    const currentScore = currentRankEntry ? getEvaluationScore(currentRankEntry, targetUseCase, currentModel, capabilityField) : (currentModel.capabilities?.[capabilityField] || null);
    const currentCost = calculateModelCost(currentModel, monthlyTokens, inputRatio);

    // 3. Map alternatives strictly from actual Artificial Analysis rankings
    const cleanSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let alternatives = [];
    if (rankData.length > 0) {
      for (const item of rankData) {
        if (!item.slug && !item.modelId) continue;
        
        let dbModel = null;
        if (item.modelId) {
          dbModel = allModels.find(m => m._id === item.modelId || m._id.toLowerCase() === item.modelId.toLowerCase());
        }
        if (!dbModel && item.slug) {
          const itemClean = cleanSlug(item.slug);
          dbModel = allModels.find(m => cleanSlug(m._id.split('/')[1] || '') === itemClean);
          if (!dbModel) {
            dbModel = allModels.find(m => {
              const mClean = cleanSlug(m._id.split('/')[1] || '');
              return mClean.includes(itemClean) || itemClean.includes(mClean);
            });
          }
        }
        if (!dbModel && item.name) {
          const itemCleanName = cleanSlug(item.name);
          dbModel = allModels.find(m => cleanSlug(m.name || '') === itemCleanName);
        }

        const inP = item.pricing?.price_1m_input_tokens || dbModel?.endpoints?.[0]?.input_cost_per_m || 0;
        const outP = item.pricing?.price_1m_output_tokens || dbModel?.endpoints?.[0]?.output_cost_per_m || 0;
        
        // Skip models that do not have pay-as-you-go pricing published
        if (inP <= 0 || outP <= 0) continue;

        const candidateId = dbModel?._id || item.modelId || `unknown/${item.slug}`;
        if (alternatives.some(alt => alt._id === candidateId || (alt.slug && alt.slug === item.slug))) {
          continue;
        }

        const inputTokens = monthlyTokens * inputRatio;
        const outputTokens = monthlyTokens * (1 - inputRatio);
        const cost = (inputTokens / 1000000 * inP) + (outputTokens / 1000000 * outP);
        const score = getEvaluationScore(item, targetUseCase, dbModel, capabilityField);
        const tps = item.median_output_tokens_per_second || dbModel?.capabilities?.tokens_per_second || null;
        const ttftMs = item.median_time_to_first_token_seconds ? Math.round(item.median_time_to_first_token_seconds * 1000) : (dbModel?.capabilities?.time_to_first_token_ms || null);
        const itemRank = (typeof item.rank === 'number' && item.rank > 0) ? item.rank : (parseInt(item.rank) || null);

        alternatives.push({
          _id: candidateId,
          slug: item.slug,
          name: item.name || dbModel?.name,
          developer: dbModel?.developer || item.organization || 'AI Provider',
          context_length: dbModel?.context_length || null,
          performance_score: score,
          tokens_per_second: tps,
          time_to_first_token_ms: ttftMs,
          cost_per_m_input: inP,
          cost_per_m_output: outP,
          cache_read_cost_per_m: dbModel?.endpoints?.[0]?.cache_read_cost_per_m || 0,
          monthly_cost: cost,
          category_rank: itemRank,
          rating: item.rating || null
        });
      }
    } else {
      alternatives = allModels
        .filter(m => m.endpoints && m.endpoints.length > 0 && m.endpoints[0].input_cost_per_m > 0 && m.endpoints[0].output_cost_per_m > 0)
        .map((m, idx) => {
          const cost = calculateModelCost(m, monthlyTokens, inputRatio);
          const score = m.capabilities?.[capabilityField] || null;
          return {
            _id: m._id,
            slug: m._id.split('/')[1] || 'model',
            name: m.name,
            developer: m.developer,
            context_length: m.context_length || null,
            performance_score: score,
            tokens_per_second: m.capabilities?.tokens_per_second || null,
            time_to_first_token_ms: m.capabilities?.time_to_first_token_ms || null,
            cost_per_m_input: m.endpoints[0].input_cost_per_m,
            cost_per_m_output: m.endpoints[0].output_cost_per_m,
            cache_read_cost_per_m: m.endpoints[0].cache_read_cost_per_m || 0,
            monthly_cost: cost,
            category_rank: idx + 1,
            rating: null
          };
        });
    }

    // Apply strict filtering and ordering for the 3 modes
    let filteredAlternatives = [];
    if (optimizationGoal === 'performance') {
      // Performance Preservation mode: models with better rank AND lower cost in the selected category
      filteredAlternatives = alternatives.filter(alt => {
        if (alt._id === currentModel._id || (alt.slug && alt.slug === currentSlug)) return false;
        if (alt.monthly_cost >= currentCost) return false;
        if (currentRank !== null && alt.category_rank !== null && alt.category_rank >= currentRank) return false;
        if (currentScore !== null && alt.performance_score !== null && alt.performance_score < currentScore) return false;
        return true;
      });
      // Sort by best rank (ascending), then by lower monthly cost
      filteredAlternatives.sort((a, b) => {
        const rkA = a.category_rank ?? 99999;
        const rkB = b.category_rank ?? 99999;
        return (rkA - rkB) || (a.monthly_cost - b.monthly_cost);
      });
    } else if (optimizationGoal === 'cost') {
      // Cost Reduction mode: models within user desired cost cut target, sorted by best rank
      const maxAllowedCost = currentCost * (1 - (costCutPercentage / 100));
      filteredAlternatives = alternatives.filter(alt => {
        if (alt._id === currentModel._id || (alt.slug && alt.slug === currentSlug)) return false;
        return alt.monthly_cost <= maxAllowedCost;
      });
      // Sort by best rank among desired cost, then by lower cost
      filteredAlternatives.sort((a, b) => {
        const rkA = a.category_rank ?? 99999;
        const rkB = b.category_rank ?? 99999;
        return (rkA - rkB) || (a.monthly_cost - b.monthly_cost);
      });
    } else if (optimizationGoal === 'quality') {
      // Quality Focus mode: ignore cost, only recommend top ranked models in the selected category
      filteredAlternatives = alternatives.filter(alt => {
        if (alt._id === currentModel._id || (alt.slug && alt.slug === currentSlug)) return false;
        return true;
      });
      // Sort strictly by best rank in category
      filteredAlternatives.sort((a, b) => {
        const rkA = a.category_rank ?? 99999;
        const rkB = b.category_rank ?? 99999;
        return (rkA - rkB) || (a.monthly_cost - b.monthly_cost);
      });
    } else {
      // Default: Performance Preservation
      filteredAlternatives = alternatives.filter(alt => {
        if (alt._id === currentModel._id || (alt.slug && alt.slug === currentSlug)) return false;
        if (alt.monthly_cost >= currentCost) return false;
        if (currentRank !== null && alt.category_rank !== null && alt.category_rank >= currentRank) return false;
        if (currentScore !== null && alt.performance_score !== null && alt.performance_score < currentScore) return false;
        return true;
      });
      filteredAlternatives.sort((a, b) => {
        const rkA = a.category_rank ?? 99999;
        const rkB = b.category_rank ?? 99999;
        return (rkA - rkB) || (a.monthly_cost - b.monthly_cost);
      });
    }

    // Limit to at most 5 models
    const topAlternatives = filteredAlternatives.slice(0, 5);

    // 4. Construct reports with accurate performance increase / decrease metrics
    const recommendations = topAlternatives.map(alt => {
      const savings = currentCost - alt.monthly_cost;
      const rankDelta = (currentRank !== null && alt.category_rank !== null) ? (currentRank - alt.category_rank) : null;
      const perfDelta = (currentScore !== null && alt.performance_score !== null && currentScore > 0)
        ? round1(((alt.performance_score - currentScore) / currentScore) * 100)
        : null;
      const performanceRetained = (currentScore !== null && alt.performance_score !== null && currentScore > 0)
        ? round1((alt.performance_score / currentScore) * 100)
        : null;

      return {
        modelId: alt._id,
        slug: alt.slug,
        name: alt.name,
        developer: alt.developer,
        context_length: alt.context_length,
        performance_score: alt.performance_score,
        category_rank: alt.category_rank,
        baseline_rank: currentRank,
        rank_delta: rankDelta,
        performance_delta_percentage: perfDelta,
        tokens_per_second: alt.tokens_per_second,
        time_to_first_token_ms: alt.time_to_first_token_ms,
        cost_per_m_input: alt.cost_per_m_input,
        cost_per_m_output: alt.cost_per_m_output,
        cache_read_cost_per_m: alt.cache_read_cost_per_m,
        monthly_cost: round2(alt.monthly_cost),
        projected_monthly_savings: round2(savings),
        projected_annual_savings: round2(savings * 12),
        performance_retained_percentage: performanceRetained,
        recommendation_score: alt.category_rank
      };
    });

    const isAlreadyOptimized = (filteredAlternatives.length === 0 && optimizationGoal === 'performance');
    const recResponse = {
      selectedCategory: targetUseCase,
      alreadyOptimized: isAlreadyOptimized,
      currentBaseline: {
        modelId: currentModel._id,
        slug: currentSlug,
        name: currentModel.name,
        performance_score: currentScore,
        category_rank: currentRank,
        monthly_cost: round2(currentCost),
        tokens_per_second: currentRankEntry?.median_output_tokens_per_second || currentModel.capabilities?.tokens_per_second || null,
        time_to_first_token_ms: currentRankEntry?.median_time_to_first_token_seconds ? Math.round(currentRankEntry.median_time_to_first_token_seconds * 1000) : (currentModel.capabilities?.time_to_first_token_ms || null),
        cost_per_m_input: currentModel.endpoints?.[0]?.input_cost_per_m ?? currentRankEntry?.pricing?.price_1m_input_tokens ?? 0,
        cost_per_m_output: currentModel.endpoints?.[0]?.output_cost_per_m ?? currentRankEntry?.pricing?.price_1m_output_tokens ?? 0
      },
      recommendations
    };
    await cache.set(recCacheKey, recResponse, 300); // 5 minutes TTL
    return res.json(recResponse);
  } catch (error) {
    console.error('Audit Recommendation Route Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});
// Route to fetch raw Artificial Analysis API data for the home page analysis dashboard
router.get('/analysis/raw-data', async (req, res) => {
  try {
    const cachedData = await cache.get('audex:analysis:raw_data');
    if (cachedData) {
      return res.json(cachedData);
    }
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
        modelId: item.modelId || item.id || `unknown/${item.slug}`,
        name: item.name,
        creator: item.model_creator?.name || item.organization || 'Unknown',
        release_date: item.release_date,
        rating: item.rating || item.arena_elo || null,
        rank: item.rank || null,
        intelligence_index: parseFloat(evaluations.artificial_analysis_intelligence_index) || null,
        coding_index: parseFloat(evaluations.artificial_analysis_coding_index) || null,
        math_index: parseFloat(evaluations.artificial_analysis_math_index) || null,
        gpqa: parseFloat(evaluations.gpqa) || null,
        hle: parseFloat(evaluations.hle) || null,
        throughput: parseFloat(item.median_output_tokens_per_second) || null,
        ttft: parseFloat(item.median_time_to_first_token_seconds) || null,
        inputCost,
        outputCost,
        blendedPrice,
        pricing: item.pricing || { price_1m_input_tokens: inputCost, price_1m_output_tokens: outputCost },
        evaluations: evaluations
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

    const responseData = {
      fetched_at: rawData.fetched_at_utc,
      categories: rawData.categories || {},
      llms: processedLlms,
      media: mediaCategories
    };
    await cache.set('audex:analysis:raw_data', responseData, 1800); // 30 minutes TTL
    return res.json(responseData);
  } catch (error) {
    console.error('Error fetching raw analysis data:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Route to fetch raw subscription tiers list (with prices)
router.get('/subscription-tiers/raw', async (req, res) => {
  try {
    let tiers = await getSubscriptionTiers();
    if (!tiers || tiers.length === 0) {
      tiers = subscriptionTiers;
    } else {
      subscriptionTiers = tiers;
    }
    res.json(tiers || []);
  } catch (error) {
    console.error('Error serving raw subscription tiers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to fetch grouped and formatted subscription tools dynamically from local subscription_tiers.json
router.get('/subscription-tiers/list', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    if (!force) {
      const cachedTiers = await cache.get('audex:tiers:list');
      if (cachedTiers && Array.isArray(cachedTiers) && cachedTiers.length > 0) {
        return res.json(cachedTiers);
      }
    }

    let liveTiers = await getSubscriptionTiers();
    if (!liveTiers || liveTiers.length === 0) {
      liveTiers = await syncSubscriptionTiers();
    }
    if (liveTiers && liveTiers.length > 0) {
      subscriptionTiers = liveTiers;
    } else if (subscriptionTiers && subscriptionTiers.length > 0) {
      liveTiers = subscriptionTiers;
    }

    if (!liveTiers || liveTiers.length === 0) {
      return res.json([]);
    }

    const getEmojiForProvider = (name) => {
      const n = (name || '').toLowerCase();
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
      if (n.includes('alibaba') || n.includes('qwen')) return '☁️';
      if (n.includes('cohere')) return '🌿';
      if (n.includes('v0')) return '▲';
      if (n.includes('gamma')) return '✨';
      if (n.includes('midjourney')) return '🎨';
      if (n.includes('runway')) return '🎬';
      if (n.includes('elevenlabs')) return '🗣️';
      if (n.includes('suno')) return '🎵';
      return '🔧';
    };

    const getDescriptionForProvider = (name) => {
      const n = (name || '').toLowerCase();
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
      if (n.includes('alibaba') || n.includes('qwen')) return 'Alibaba Qwen Chat';
      if (n.includes('cohere')) return 'Cohere enterprise model platform';
      if (n.includes('v0')) return 'Vercel UI generator';
      if (n.includes('gamma')) return 'AI presentation generator';
      if (n.includes('midjourney')) return 'AI image generator';
      if (n.includes('runway')) return 'AI video generator';
      if (n.includes('elevenlabs')) return 'AI voice generator';
      if (n.includes('suno')) return 'AI music generator';
      return `${name} AI integration`;
    };

    const getFriendlyToolName = (prov) => {
      const p = (prov || '').toLowerCase();
      if (p === 'openai') return 'ChatGPT';
      if (p === 'anthropic') return 'Claude';
      if (p === 'google') return 'Gemini';
      if (p === 'github') return 'GitHub Copilot';
      if (p === 'xai') return 'xAI';
      if (p === 'alibaba') return 'Alibaba (Qwen)';
      return prov;
    };

    const grouped = {};
    liveTiers.forEach(tier => {
      const prov = tier.provider || 'Other';
      const key = prov.toLowerCase();
      const toolId = getFriendlyToolName(prov);

      if (!grouped[key]) {
        grouped[key] = {
          id: toolId,
          name: toolId,
          provider: prov,
          desc: getDescriptionForProvider(prov),
          icon: getEmojiForProvider(prov),
          type: 'subscription',
          plans: [],
          defaultPlan: '',
          defaultSeats: (key.includes('github') || key.includes('copilot') || key.includes('cursor') || key.includes('anthropic') || key.includes('claude')) ? 5 : 1,
          planModels: {},
          planDetails: {},
          allModels: [],
          tiers: []
        };
      }
      if (!grouped[key].plans.includes(tier.plan)) {
        grouped[key].plans.push(tier.plan);
      }

      const rawList = (tier.rawModels && tier.rawModels.length > 0) ? tier.rawModels : (tier.models || []);
      const tierModels = rawList.filter(m => !isDiscontinuedModel(m));
      tierModels.sort((a, b) => getModelRecencyScore(b) - getModelRecencyScore(a));

      grouped[key].planModels[tier.plan] = tierModels;
      grouped[key].planDetails[tier.plan] = {
        monthlyPrice: tier.monthlyPrice,
        annualPrice: tier.annualPrice,
        limits: tier.limits || '',
        models: tierModels,
        rawModels: tierModels,
        slugModels: (tier.models || []).filter(m => !isDiscontinuedModel(m))
      };
      grouped[key].tiers.push(tier);
      tierModels.forEach(m => {
        if (!grouped[key].allModels.includes(m)) {
          grouped[key].allModels.push(m);
        }
      });
    });

    Object.keys(grouped).forEach(key => {
      const item = grouped[key];
      const proPlan = item.plans.find(p => p.toLowerCase().includes('pro') || p.toLowerCase().includes('plus'));
      item.defaultPlan = proPlan || item.plans[0] || 'Free';
      // Ensure allModels has the latest models first and no discontinued models
      item.allModels = item.allModels.filter(m => !isDiscontinuedModel(m));
      item.allModels.sort((a, b) => getModelRecencyScore(b) - getModelRecencyScore(a));
    });

    const result = Object.values(grouped);
    await cache.set('audex:tiers:list', result, 900); // 15 minutes TTL
    return res.json(result);
  } catch (error) {
    console.error('Error serving subscription-tiers list:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to get list of all models for dropdown baselines
router.get('/models/list', async (req, res) => {
  try {
    const cachedList = await cache.get('audex:models:list');
    if (cachedList) {
      return res.json(cachedList);
    }

    let allModels = await getCachedAllModels();

    if (!allModels || allModels.length === 0) {
      console.log('🔄 Database is empty, auto-triggering local sync/seeding in models list route...');
      const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');
      await syncArtificialAnalysis();
      await cache.del('audex:models:all_docs');
      allModels = await getCachedAllModels();
    }

    // Format models
    const formatted = allModels.map(m => ({
      id: m._id,
      name: m.name || m._id
    }));

    // Sort alphabetically by name
    formatted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    await cache.set('audex:models:list', formatted, 900); // 15 minutes TTL
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
    if (user) {
      if (!user.credits) {
        user.credits = { starter: 999, pro: 999, proMax: 999 };
      }
      user.markModified('credits');
      await user.save();
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.Gemini_Api_key;
  if (!geminiKey) {
    const fallbackReport = generateFallbackCompareReport(baseline, recommended);
    return res.json({
      report: fallbackReport,
      updatedCredits: user ? user.credits : null
    });
  }

  const prompt = `You are an expert AI subscription auditor and spend optimizer. 
Given details of two models (a baseline model and a recommended alternative model), generate a comprehensive spend optimization and migration report.

Baseline Model:
- Name: ${baseline.name}
- Creator: ${baseline.creator || baseline.developer || 'Unknown'}
- Model ID: ${baseline.modelId || 'Unknown'}
- Cost per 1M Input Tokens: ${baseline.cost_per_m_input ?? baseline.pricing?.price_1m_input_tokens ?? 0}
- Cost per 1M Output Tokens: ${baseline.cost_per_m_output ?? baseline.pricing?.price_1m_output_tokens ?? 0}
- Tokens Per Second (Speed): ${baseline.tokens_per_second ?? baseline.throughput ?? 'N/A'}
- Coding Index: ${baseline.coding_index ?? 'N/A'}
- Intelligence Index: ${baseline.intelligence_index ?? 'N/A'}
- Context Length: ${baseline.context_length ?? 'N/A'}

Recommended Model:
- Name: ${recommended.name}
- Creator: ${recommended.creator || recommended.developer || 'Unknown'}
- Model ID: ${recommended.modelId || 'Unknown'}
- Cost per 1M Input Tokens: ${recommended.cost_per_m_input ?? recommended.pricing?.price_1m_input_tokens ?? 0}
- Cost per 1M Output Tokens: ${recommended.cost_per_m_output ?? recommended.pricing?.price_1m_output_tokens ?? 0}
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
      "A detailed paragraph explaining why switching makes architectural and financial sense...",
      "Another paragraph detailing quality analysis..."
    ],
    "quality_analysis_box": "Quality Analysis: The recommended alternative retains approximately X% of baseline capability while running on an optimized inference route."
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
    "migration_script": "The custom migration script..."
  }
}`;

  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`, {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    }, { timeout: 15000 });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Received empty response from Gemini API');
    }

    const report = JSON.parse(text.trim());
    res.json({
      report,
      updatedCredits: req.user ? user?.credits : null
    });
  } catch (error) {
    console.warn('Gemini report generation warning, using fallback algorithm:', error.message);
    const fallbackReport = generateFallbackCompareReport(baseline, recommended);
    res.json({
      report: fallbackReport,
      updatedCredits: req.user ? user?.credits : null
    });
  }
});

// Route: Cron synchronization endpoint
const handleCronSync = async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET || process.env.ADMIN_SECRET;
    const providedSecret = req.query.secret || req.headers['x-cron-secret'];
    if (cronSecret && providedSecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized: Invalid cron secret.' });
    }

    console.log('🔄 Triggering automated ranking sync via /cron/sync...');
    const result = await runDailyRankingPipeline();
    await cache.del('audex:models:all_docs');
    await cache.del('audex:models:list');
    await cache.del('audex:tiers:list');
    await cache.del('audex:tiers:raw');
    await cache.del('audex:analysis:raw_data');
    await cache.delByPrefix('audex:rec:');
    await cache.delByPrefix('audex:rank:');
    res.json({ success: true, result });
  } catch (err) {
    console.error('Cron sync error:', err);
    res.status(500).json({ error: 'Cron sync failed', details: err.message });
  }
};
router.get('/cron/sync', handleCronSync);
router.post('/cron/sync', handleCronSync);

// Route: Sync subscription tiers dynamically
router.post('/subscription-tiers/sync', async (req, res) => {
  try {
    const tiers = await syncSubscriptionTiers();
    if (tiers && tiers.length > 0) {
      subscriptionTiers = tiers;
    }
    await cache.del('audex:tiers:list');
    await cache.del('audex:tiers:raw');
    res.json({ success: true, count: (tiers || []).length });
  } catch (err) {
    console.error('Subscription tiers sync failed:', err);
    res.status(500).json({ error: 'Sync failed', details: err.message });
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
    await cache.del('audex:models:all_docs');
    await cache.del('audex:models:list');
    await cache.del('audex:tiers:list');
    await cache.del('audex:tiers:raw');
    await cache.del('audex:analysis:raw_data');
    await cache.delByPrefix('audex:rec:');
    await cache.delByPrefix('audex:rank:');
    res.json({ message: 'Synchronization and seeding completed successfully.' });
  } catch (err) {
    console.error('Manual synchronization failed:', err);
    res.status(500).json({ error: 'Manual synchronization failed', details: err.message });
  }
});

// Route: Get cache performance stats and system health
router.get('/cache/stats', (req, res) => {
  try {
    res.json(cache.getStats());
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve cache stats' });
  }
});

// Route: Clear cache manually
router.post('/cache/clear', async (req, res) => {
  try {
    await cache.clear();
    res.json({ message: 'Multi-tier cache cleared successfully', stats: cache.getStats() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

module.exports = router;
