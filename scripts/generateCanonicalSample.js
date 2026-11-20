const { generateSampleReport } = require('../services/sampleReportService');

if (require.main === module) {
  generateSampleReport({ log: true })
    .then(() => {
      console.log('\nCanonical sample audit generation finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to generate canonical sample audit:', err);
      process.exit(1);
    });
}

module.exports = { generateSampleReport };
