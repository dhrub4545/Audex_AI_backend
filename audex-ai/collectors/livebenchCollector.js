const { scrapeLiveBenchMath } = require('../../services/livebenchScraper');

/**
 * LiveBench AI Math Collector
 * Source: https://livebench.ai (repo: LiveBench/livebench.github.io)
 * Automatically fetches and parses contamination-free mathematics evaluations
 * (AMPS_Hard, integrals_with_game, math_comp, olympiad).
 */
async function collectLiveBenchMath(aaModels = null) {
  console.log('📐 LiveBench Collector: Starting LiveBench AI Mathematics benchmark collection...');
  try {
    const models = await scrapeLiveBenchMath(aaModels);
    console.log(`🎉 LiveBench Collector: Successfully collected ${models.length} math benchmark models.`);
    return models;
  } catch (error) {
    console.error('❌ LiveBench Collector Error:', error.message);
    throw error;
  }
}

if (require.main === module) {
  collectLiveBenchMath()
    .then(models => {
      console.log(`LiveBench Math Models Collected: ${models.length}`);
      process.exit(0);
    })
    .catch(() => process.exit(1));
}

module.exports = { collectLiveBenchMath };
