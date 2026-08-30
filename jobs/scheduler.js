const cron = require('node-cron');
const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');
const { runDailyRankingPipeline } = require('../services/dailyRankingPipeline');

function initScheduler() {
  if (process.env.VERCEL) {
    console.log('⏰ Ingestion Scheduler: Running on Vercel. Background node-cron disabled in favor of Vercel Crons (/api/audits/cron/sync).');
    return;
  }

  console.log('⏰ Ingestion Scheduler: Initializing background cron jobs...');

  // 1. Run Daily Automated AI Ranking Pipeline at 00:00 UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('⏰ Ingestion Scheduler: Starting daily AI ranking pipeline run...');
    try {
      await runDailyRankingPipeline();
    } catch (err) {
      console.error('⏰ Ingestion Scheduler: Daily AI ranking pipeline failed:', err.message);
    }
  });

  // 2. Run Artificial Analysis sync hourly
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Ingestion Scheduler: Starting hourly Artificial Analysis sync...');
    try {
      await syncArtificialAnalysis();
    } catch (err) {
      console.error('⏰ Ingestion Scheduler: Artificial Analysis hourly sync failed:', err.message);
    }
  });

  // 3. Trigger initial synchronization if explicitly enabled via environment variable
  if (process.env.RUN_INITIAL_SYNC === 'true') {
    (async () => {
      console.log('🚀 Ingestion Scheduler: Triggering initial synchronization on startup (RUN_INITIAL_SYNC=true)...');
      try {
        await runDailyRankingPipeline();
        console.log('🚀 Ingestion Scheduler: Initial synchronization completed successfully!');
      } catch (err) {
        console.error('🚀 Ingestion Scheduler: Initial synchronization encountered an error:', err.message);
        await syncArtificialAnalysis().catch(() => {});
      }
    })();
  } else {
    console.log('ℹ️ Ingestion Scheduler: Startup scraping skipped (RUN_INITIAL_SYNC!=true). Scheduled cron jobs are active.');
  }
}

module.exports = { initScheduler };
