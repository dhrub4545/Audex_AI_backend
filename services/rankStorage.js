const fs = require('fs');
const path = require('path');
const RankData = require('../models/RankData');

const RANK_DIR = path.join(__dirname, '../data/rank');
const RAW_DATA_PATH = path.join(__dirname, '../data/raw_data.json');

/**
 * Save rank category data to MongoDB Atlas.
 */
async function saveRankCategory(categoryKey, data) {
  // 1. Save to MongoDB Atlas
  try {
    await RankData.findOneAndUpdate(
      { key: categoryKey },
      { data, updated_at: new Date() },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.warn(`⚠️ MongoDB RankData save warning for [${categoryKey}]:`, err.message);
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
  // 1. Check MongoDB Atlas
  try {
    const doc = await RankData.findOne({ key: categoryKey }).lean();
    if (doc && doc.data) {
      return doc.data;
    }
  } catch (err) {
    console.warn(`⚠️ MongoDB RankData read warning for [${categoryKey}]:`, err.message);
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
 * Save raw_data JSON payload to MongoDB Atlas and attempt local file write.
 */
async function saveRawData(rawData) {
  // 1. Save to MongoDB Atlas
  try {
    await RankData.findOneAndUpdate(
      { key: 'raw_data' },
      { data: rawData, updated_at: new Date() },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.warn('⚠️ MongoDB RawData save warning:', err.message);
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
  // 1. Check MongoDB Atlas
  try {
    const doc = await RankData.findOne({ key: 'raw_data' }).lean();
    if (doc && doc.data) {
      return doc.data;
    }
  } catch (err) {
    console.warn('⚠️ MongoDB RawData read warning:', err.message);
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

module.exports = {
  saveRankCategory,
  getRankCategory,
  saveRawData,
  getRawData
};
