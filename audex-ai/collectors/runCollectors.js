const { scrapeArtificialAnalysis } = require('../../services/artificialAnalysisScraper');

async function runAllCollectors() {
  console.log('🚀 Audex AI Aggregation Engine: Running Artificial Analysis Web Scraper...');

  try {
    const scrapedModels = await scrapeArtificialAnalysis();
    console.log(`🎉 Artificial Analysis Web Scraper completed successfully with ${scrapedModels.length} models!`);
    return scrapedModels;
  } catch (error) {
    console.error('❌ Error running Artificial Analysis Web Scraper:', error.message);
    throw error;
  }
}

if (require.main === module) {
  runAllCollectors();
}

module.exports = { runAllCollectors };
