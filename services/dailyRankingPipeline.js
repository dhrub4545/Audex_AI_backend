const mongoose = require('mongoose');
require('dotenv').config();
const { runAudexPipeline } = require('../audex-ai/scheduler/update');

/**
 * Main execution routine for daily pipeline using Audex AI Benchmark Aggregation Engine.
 */
async function runDailyRankingPipeline(options = {}) {
  console.log('🚀 Delegating daily ranking pipeline to Audex AI Benchmark Engine...');
  if (mongoose.connection.readyState !== 1) {
    const MONGODB_URI = process.env.MONGODB_URI || process.env.mongo_db || 'mongodb://localhost:27017/audit-ai';
    console.log('🔌 Connecting to MongoDB for daily pipeline...');
    try {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ MongoDB connected successfully for daily pipeline.');
    } catch (err) {
      console.warn('⚠️ Could not connect to MongoDB for daily pipeline, proceeding with file fallback:', err.message);
    }
  }
  return await runAudexPipeline();
}

// Execute directly if run via CLI (node dailyRankingPipeline.js)
if (require.main === module) {
  runDailyRankingPipeline()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runDailyRankingPipeline };
