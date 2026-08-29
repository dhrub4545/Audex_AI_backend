const { runAllCollectors } = require('../collectors/runCollectors');
const { generateAllRankFiles } = require('../algorithms/overall_score');
const { syncArtificialAnalysis } = require('../../services/artificialAnalysisSync');
const { syncSubscriptionTiers } = require('../../services/subscriptionTierSync');

/**
 * Complete Audex AI Benchmark Automation Pipeline
 */
async function runAudexPipeline() {
  console.log('====================================================');
  console.log('🚀 Starting Audex AI Aggregation Pipeline (Artificial Analysis)');
  console.log('====================================================');

  const startTime = Date.now();

  try {
    // Phase 1: Web Scrape Artificial Analysis
    console.log('\n--- Phase 1: Scraping Artificial Analysis Data ---');
    const scrapedModels = await runAllCollectors();

    // Phase 2: Category Scoring & Rank File Generation
    console.log('\n--- Phase 2: Generating 30 Category Rank Files ---');
    const totalRankFiles = await generateAllRankFiles(scrapedModels);

    // Phase 3: Synchronize raw_data.json & Local Database
    console.log('\n--- Phase 3: Generating raw_data.json & Local Database Sync ---');
    await syncArtificialAnalysis(scrapedModels);

    // Phase 4: Synchronize subscription_tiers.json & SaaS Plans
    console.log('\n--- Phase 4: Auto-syncing Subscription Tiers & SaaS Plans ---');
    await syncSubscriptionTiers(scrapedModels);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n====================================================');
    console.log(`🎉 Audex AI Pipeline completed successfully in ${elapsed}s!`);
    console.log(`📊 Models Scraped & Processed: ${scrapedModels.length}`);
    console.log(`💾 Rank Files Updated in backend/data/rank/: ${totalRankFiles}`);
    console.log(`💳 Subscription Tiers Synchronized: Active`);
    console.log('====================================================\n');

    return {
      success: true,
      modelsProcessed: scrapedModels.length,
      rankFilesUpdated: totalRankFiles,
      elapsedSeconds: elapsed
    };
  } catch (error) {
    console.error('❌ Audex AI Pipeline Error:', error.message, error.stack);
    throw error;
  }
}

if (require.main === module) {
  runAudexPipeline()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runAudexPipeline };
