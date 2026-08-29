const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const RankData = require('../models/RankData');

const RANK_DIR = path.join(__dirname, '../data/rank');
const RAW_DATA_PATH = path.join(__dirname, '../data/raw_data.json');

/**
 * Save rank category data to MongoDB Atlas.
 */
async function saveRankCategory(categoryKey, data) {
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

  // 2. Cache in /tmp (ephemeral)
  try {
    const tmpDir = path.join('/tmp', 'rank');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `${categoryKey}.json`), JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Get rank category data from MongoDB Atlas first, fallback to /tmp.
 */
async function getRankCategory(categoryKey) {
  // 1. Check MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await RankData.findOne({ key: categoryKey }).lean();
      if (doc && doc.data) {
        return doc.data;
      }
    } catch (err) {
      console.warn(`⚠️ MongoDB RankData read warning for [${categoryKey}]:`, err.message);
    }
  }

  // 2. Fallback to /tmp
  const tmpPath = path.join('/tmp/rank', `${categoryKey}.json`);
  if (fs.existsSync(tmpPath)) {
    try {
      const content = fs.readFileSync(tmpPath, 'utf8');
      return JSON.parse(content);
    } catch (_) {}
  }

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
 * Save raw_data JSON payload to MongoDB Atlas and attempt local file write.
 */
async function saveRawData(rawData) {
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

  // 2. Attempt local file system write
  try {
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(RAW_DATA_PATH, JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`💾 Saved raw_data.json to local disk: ${RAW_DATA_PATH}`);
  } catch (fsErr) {
    // Read-only filesystem on Vercel
    try {
      fs.writeFileSync('/tmp/raw_data.json', JSON.stringify(rawData, null, 2), 'utf8');
      console.log('💾 Saved raw_data.json to /tmp/raw_data.json');
    } catch (_) {}
  }
}

/**
 * Get raw_data JSON payload from MongoDB Atlas first, fallback to disk / /tmp.
 */
async function getRawData() {
  // 1. Check MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await RankData.findOne({ key: 'raw_data' }).lean();
      if (doc && doc.data) {
        return doc.data;
      }
    } catch (err) {
      console.warn('⚠️ MongoDB RawData read warning:', err.message);
    }
  }

  // 2. Fallback to local file system
  if (fs.existsSync(RAW_DATA_PATH)) {
    try {
      const content = fs.readFileSync(RAW_DATA_PATH, 'utf8');
      return JSON.parse(content);
    } catch (_) {}
  }

  // 3. Fallback to /tmp
  if (fs.existsSync('/tmp/raw_data.json')) {
    try {
      const content = fs.readFileSync('/tmp/raw_data.json', 'utf8');
      return JSON.parse(content);
    } catch (_) {}
  }

  return null;
}

const SUBSCRIPTION_TIERS_PATH = path.join(__dirname, '../data/subscription_tiers.json');

/**
 * Save subscription_tiers JSON payload to MongoDB Atlas and attempt local file write.
 */
async function saveSubscriptionTiers(tiersData) {
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

  // 2. Attempt local file system write
  try {
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(SUBSCRIPTION_TIERS_PATH, JSON.stringify(tiersData, null, 2), 'utf8');
    console.log(`💾 Saved subscription_tiers.json to local disk: ${SUBSCRIPTION_TIERS_PATH}`);
  } catch (fsErr) {
    // Read-only filesystem on Vercel /tmp fallback
    try {
      fs.writeFileSync('/tmp/subscription_tiers.json', JSON.stringify(tiersData, null, 2), 'utf8');
      console.log('💾 Saved subscription_tiers.json to /tmp/subscription_tiers.json');
    } catch (_) {}
  }
}

/**
 * Get subscription_tiers JSON payload from MongoDB Atlas first, fallback to disk / /tmp.
 */
async function getSubscriptionTiers() {
  // 1. Check MongoDB Atlas if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await RankData.findOne({ key: 'subscription_tiers' }).lean();
      if (doc && doc.data && Array.isArray(doc.data) && doc.data.length > 0) {
        return doc.data;
      }
    } catch (err) {
      console.warn('⚠️ MongoDB SubscriptionTiers read warning:', err.message);
    }
  }

  // 2. Fallback to local file system
  if (fs.existsSync(SUBSCRIPTION_TIERS_PATH)) {
    try {
      const content = fs.readFileSync(SUBSCRIPTION_TIERS_PATH, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (_) {}
  }

  // 3. Fallback to /tmp
  if (fs.existsSync('/tmp/subscription_tiers.json')) {
    try {
      const content = fs.readFileSync('/tmp/subscription_tiers.json', 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (_) {}
  }

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
