const cron = require('node-cron');
const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');

function initScheduler() {
  console.log('⏰ Ingestion Scheduler: Initializing background cron jobs...');

  // 1. Run Artificial Analysis sync hourly
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Ingestion Scheduler: Starting hourly Artificial Analysis sync...');
    try {
      await syncArtificialAnalysis();
    } catch (err) {
      console.error('⏰ Ingestion Scheduler: Artificial Analysis hourly sync failed:', err.message);
    }
  });



  // 3. Trigger initial sync in the background on startup
  (async () => {
    console.log('🚀 Ingestion Scheduler: Triggering initial synchronization on startup...');
    try {
      // Sync live pricing and capabilities from Artificial Analysis
      await syncArtificialAnalysis();
      
      console.log('🚀 Ingestion Scheduler: Initial synchronization completed successfully!');
    } catch (err) {
      console.error('🚀 Ingestion Scheduler: Initial synchronization encountered an error:', err.message);
    }
  })();
}

module.exports = { initScheduler };
