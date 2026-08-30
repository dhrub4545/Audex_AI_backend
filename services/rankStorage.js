const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const RankData = require('../models/RankData');

const RANK_DIR = path.join(__dirname, '../data/rank');
const RAW_DATA_PATH = path.join(__dirname, '../data/raw_data.json');
const SUBSCRIPTION_TIERS_PATH = path.join(__dirname, '../data/subscription_tiers.json');

// In-memory runtime cache with TTL (5 minutes) to avoid repeated disk reads / JSON parses
const memoryCache = {
  categories: new Map(),
  rawData: null,
  rawDataExpires: 0,
  subTiers: null,
  subTiersExpires: 0
};
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Save rank category data to MongoDB Atlas and ephemeral disk cache asynchronously.
 */
async function saveRankCategory(categoryKey, data) {
  // Update in-memory cache
  memoryCache.categories.set(categoryKey, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  // 1. Save to MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      await RankData.findOneAndUpdate(
        { key: categoryKey },
        { data, updated_at: new Date() },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.warn(`⚠️ MongoDB RankData save warning for [${categoryKey}]:`, err.message);
    }
  }

  // 2. Cache in /tmp asynchronously
  try {
    const tmpDir = path.join('/tmp', 'rank');
    await fs.promises.mkdir(tmpDir, { recursive: true }).catch(() => {});
    await fs.promises.writeFile(path.join(tmpDir, `${categoryKey}.json`), JSON.stringify(data, null, 2), 'utf8').catch(() => {});
  } catch (_) {}
}

/**
 * Get rank category data: In-memory cache -> MongoDB Atlas -> /tmp asynchronous fallback.
 */
async function getRankCategory(categoryKey) {
  // Check in-memory cache
  const cached = memoryCache.categories.get(categoryKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // 1. Check MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await RankData.findOne({ key: categoryKey }).lean();
      if (doc && doc.data) {
        memoryCache.categories.set(categoryKey, {
          data: doc.data,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
        return doc.data;
      }
    } catch (err) {
      console.warn(`⚠️ MongoDB RankData read warning for [${categoryKey}]:`, err.message);
    }
  }

  // 2. Fallback to /tmp asynchronously
  const tmpPath = path.join('/tmp/rank', `${categoryKey}.json`);
  try {
    const content = await fs.promises.readFile(tmpPath, 'utf8');
    const parsed = JSON.parse(content);
    memoryCache.categories.set(categoryKey, {
      data: parsed,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
    return parsed;
  } catch (_) {}

  return null;
}

/**
 * Prunes large rawData payload to fit well within MongoDB 16MB BSON limit.
 */
function pruneRawDataForDb(rawData) {
  if (!rawData) return null;
  const pruned = {
    fetched_at_utc: rawData.fetched_at_utc || new Date().toISOString(),
    categories: rawData.categories || {},
    sources: {
      llms: {
        status: rawData.sources?.llms?.status || 200,
        data: (rawData.sources?.llms?.data || []).map(m => ({
          slug: m.slug,
          name: m.name,
          creator: m.creator || m.model_creator?.name || m.organization || 'Unknown',
          model_creator: m.model_creator || { name: m.creator || 'Unknown' },
          release_date: m.release_date,
          pricing: m.pricing || null,
          evaluations: m.evaluations || null,
          intelligence_index: m.intelligence_index,
          coding_index: m.coding_index,
          math_index: m.math_index,
          gpqa: m.gpqa,
          hle: m.hle,
          throughput: m.throughput || m.median_output_tokens_per_second || null,
          ttft: m.ttft || m.median_time_to_first_token_seconds || null,
          median_output_tokens_per_second: m.median_output_tokens_per_second || m.throughput || null,
          median_time_to_first_token_seconds: m.median_time_to_first_token_seconds || m.ttft || null,
          context_length: m.context_length || null,
          inputCost: m.inputCost,
          outputCost: m.outputCost,
          blendedPrice: m.blendedPrice
        }))
      },
      text_to_image: rawData.sources?.text_to_image || [],
      image_editing: rawData.sources?.image_editing || [],
      text_to_speech: rawData.sources?.text_to_speech || [],
      text_to_video: rawData.sources?.text_to_video || [],
      image_to_video: rawData.sources?.image_to_video || []
    }
  };
  return pruned;
}

/**
 * Save raw_data JSON payload to MongoDB Atlas and local disk asynchronously.
 */
async function saveRawData(rawData) {
  // Update in-memory cache
  memoryCache.rawData = rawData;
  memoryCache.rawDataExpires = Date.now() + CACHE_TTL_MS;

  // 1. Save to MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const payloadToSave = pruneRawDataForDb(rawData);
      await RankData.findOneAndUpdate(
        { key: 'raw_data' },
        { data: payloadToSave, updated_at: new Date() },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.warn('⚠️ MongoDB RawData save warning:', err.message);
    }
  }

  // 2. Attempt asynchronous local file system write
  try {
    const outputDir = path.join(__dirname, '../data');
    await fs.promises.mkdir(outputDir, { recursive: true }).catch(() => {});
    await fs.promises.writeFile(RAW_DATA_PATH, JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`💾 Saved raw_data.json to local disk (async): ${RAW_DATA_PATH}`);
  } catch (fsErr) {
    // Read-only filesystem on Vercel fallback
    try {
      await fs.promises.writeFile('/tmp/raw_data.json', JSON.stringify(rawData, null, 2), 'utf8');
      console.log('💾 Saved raw_data.json to /tmp/raw_data.json (async)');
    } catch (_) {}
  }
}

/**
 * Get raw_data JSON payload: Memory cache -> MongoDB Atlas -> Async disk -> /tmp.
 */
async function getRawData() {
  // Check memory cache first
  if (memoryCache.rawData && memoryCache.rawDataExpires > Date.now()) {
    return memoryCache.rawData;
  }

  // 1. Check MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await RankData.findOne({ key: 'raw_data' }).lean();
      if (doc && doc.data) {
        memoryCache.rawData = doc.data;
        memoryCache.rawDataExpires = Date.now() + CACHE_TTL_MS;
        return doc.data;
      }
    } catch (err) {
      console.warn('⚠️ MongoDB RawData read warning:', err.message);
    }
  }

  // 2. Fallback to local file system asynchronously
  try {
    const content = await fs.promises.readFile(RAW_DATA_PATH, 'utf8');
    const parsed = JSON.parse(content);
    memoryCache.rawData = parsed;
    memoryCache.rawDataExpires = Date.now() + CACHE_TTL_MS;
    return parsed;
  } catch (_) {}

  // 3. Fallback to /tmp asynchronously
  try {
    const content = await fs.promises.readFile('/tmp/raw_data.json', 'utf8');
    const parsed = JSON.parse(content);
    memoryCache.rawData = parsed;
    memoryCache.rawDataExpires = Date.now() + CACHE_TTL_MS;
    return parsed;
  } catch (_) {}

  return null;
}

/**
 * Save subscription_tiers JSON payload to MongoDB Atlas and local disk asynchronously.
 */
async function saveSubscriptionTiers(tiersData) {
  memoryCache.subTiers = tiersData;
  memoryCache.subTiersExpires = Date.now() + CACHE_TTL_MS;

  // 1. Save to MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      await RankData.findOneAndUpdate(
        { key: 'subscription_tiers' },
        { data: tiersData, updated_at: new Date() },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.warn('⚠️ MongoDB SubscriptionTiers save warning:', err.message);
    }
  }

  // 2. Attempt local file system write asynchronously
  try {
    const outputDir = path.join(__dirname, '../data');
    await fs.promises.mkdir(outputDir, { recursive: true }).catch(() => {});
    await fs.promises.writeFile(SUBSCRIPTION_TIERS_PATH, JSON.stringify(tiersData, null, 2), 'utf8');
    console.log(`💾 Saved subscription_tiers.json to local disk (async): ${SUBSCRIPTION_TIERS_PATH}`);
  } catch (fsErr) {
    // Read-only filesystem on Vercel fallback
    try {
      await fs.promises.writeFile('/tmp/subscription_tiers.json', JSON.stringify(tiersData, null, 2), 'utf8');
      console.log('💾 Saved subscription_tiers.json to /tmp/subscription_tiers.json (async)');
    } catch (_) {}
  }
}

/**
 * Get subscription_tiers JSON payload: Memory cache -> MongoDB Atlas -> Async disk -> /tmp.
 */
async function getSubscriptionTiers() {
  if (memoryCache.subTiers && memoryCache.subTiersExpires > Date.now() && Array.isArray(memoryCache.subTiers)) {
    return memoryCache.subTiers;
  }

  // 1. Check MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await RankData.findOne({ key: 'subscription_tiers' }).lean();
      if (doc && doc.data && Array.isArray(doc.data) && doc.data.length > 0) {
        memoryCache.subTiers = doc.data;
        memoryCache.subTiersExpires = Date.now() + CACHE_TTL_MS;
        return doc.data;
      }
    } catch (err) {
      console.warn('⚠️ MongoDB SubscriptionTiers read warning:', err.message);
    }
  }

  // 2. Fallback to local file system asynchronously
  try {
    const content = await fs.promises.readFile(SUBSCRIPTION_TIERS_PATH, 'utf8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      memoryCache.subTiers = parsed;
      memoryCache.subTiersExpires = Date.now() + CACHE_TTL_MS;
      return parsed;
    }
  } catch (_) {}

  // 3. Fallback to /tmp asynchronously
  try {
    const content = await fs.promises.readFile('/tmp/subscription_tiers.json', 'utf8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      memoryCache.subTiers = parsed;
      memoryCache.subTiersExpires = Date.now() + CACHE_TTL_MS;
      return parsed;
    }
  } catch (_) {}

  return [];
}

module.exports = {
  saveRankCategory,
  getRankCategory,
  saveRawData,
  getRawData,
  saveSubscriptionTiers,
  getSubscriptionTiers
};
