const { runAudexPipeline } = require('../audex-ai/scheduler/update');

/**
 * Main execution routine for daily pipeline using Audex AI Benchmark Aggregation Engine.
 */
async function runDailyRankingPipeline(options = {}) {
  console.log('🚀 Delegating daily ranking pipeline to Audex AI Benchmark Engine...');
  return await runAudexPipeline();
}

// Execute directly if run via CLI (node dailyRankingPipeline.js)
if (require.main === module) {
  runDailyRankingPipeline()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runDailyRankingPipeline };
