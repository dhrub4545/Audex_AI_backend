const { scrapeArtificialAnalysis } = require('../../services/artificialAnalysisScraper');
const { collectLiveBenchMath } = require('./livebenchCollector');

async function runAllCollectors() {
  console.log('🚀 Audex AI Aggregation Engine: Running Collectors (Artificial Analysis & LiveBench AI)...');

  try {
    const [scrapedModels, livebenchModels] = await Promise.all([
      scrapeArtificialAnalysis(),
      collectLiveBenchMath().catch(err => {
        console.warn('⚠️ LiveBench Math collector warning (continuing with cached data):', err.message);
        return [];
      })
    ]);

    console.log(`🎉 Collectors completed: Artificial Analysis (${scrapedModels.length} models), LiveBench Math (${livebenchModels.length} models)`);
    scrapedModels.livebenchModels = livebenchModels;
    return scrapedModels;
  } catch (error) {
    console.error('❌ Error running Web Collectors:', error.message);
    throw error;
  }
}

if (require.main === module) {
  runAllCollectors();
}

module.exports = { runAllCollectors };
