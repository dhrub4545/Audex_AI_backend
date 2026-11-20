const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const cache = require('../services/cacheService');
const { syncArtificialAnalysis } = require('../services/artificialAnalysisSync');
const { runDailyRankingPipeline } = require('../services/dailyRankingPipeline');
const { syncSubscriptionTiers } = require('../services/subscriptionTierSync');

async function invalidateAllCaches() {
  try {
    await cache.del('audex:models:all_docs');
    await cache.del('audex:models:list');
    await cache.del('audex:tiers:list');
    await cache.del('audex:tiers:raw');
    await cache.del('audex:analysis:raw_data');
    await cache.delByPrefix('audex:rec:');
    await cache.delByPrefix('audex:rank:');
  } catch (_) {}
}

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
      await invalidateAllCaches();
    } catch (err) {
      console.error('⏰ Ingestion Scheduler: Daily AI ranking pipeline failed:', err.message);
    }
  });

  // 2. Run automated pipeline hourly to scrape newly arrived models and update overall index leaderboard & subscription tiers
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Ingestion Scheduler: Starting hourly Artificial Analysis live sync...');
    try {
      await runDailyRankingPipeline();
      await invalidateAllCaches();
      console.log('⏰ Ingestion Scheduler: Hourly live sync completed successfully.');
    } catch (err) {
      console.error('⏰ Ingestion Scheduler: Hourly sync failed, attempting fallback local sync:', err.message);
      await syncArtificialAnalysis().catch(() => {});
      await syncSubscriptionTiers().catch(() => {});
      await invalidateAllCaches();
    }
  });

  // 3. Immediately verify and auto-sync subscription tiers with live models on boot
  (async () => {
    try {
      console.log('🔄 Ingestion Scheduler: Auto-syncing SaaS subscription tiers on server boot...');
      await syncSubscriptionTiers();
    } catch (err) {
      console.warn('⚠️ Ingestion Scheduler: Startup subscription tier auto-sync warning:', err.message);
    }
  })();

  // 4. Trigger automated synchronization on startup if data is missing, stale (> 1h), or RUN_INITIAL_SYNC is true
  (async () => {
    try {
      const rawPath = path.join(__dirname, '../data/raw_data.json');
      let shouldSync = false;
      if (!fs.existsSync(rawPath)) {
        shouldSync = true;
      } else {
        const stats = fs.statSync(rawPath);
        const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > 1 || process.env.RUN_INITIAL_SYNC === 'true') {
          shouldSync = true;
        }
      }
      if (shouldSync) {
        console.log('🚀 Ingestion Scheduler: Triggering automated synchronization on startup (data missing or > 1h old)...');
        await runDailyRankingPipeline();
        await invalidateAllCaches();
        console.log('🚀 Ingestion Scheduler: Startup synchronization completed successfully!');
      } else {
        console.log('ℹ️ Ingestion Scheduler: Startup data is fresh (< 1h). Scheduled cron jobs are active.');
      }
    } catch (err) {
      console.warn('⚠️ Ingestion Scheduler: Startup synchronization warning:', err.message);
    }
  })();
}

module.exports = { initScheduler };
