const mongoose = require('mongoose');

const RankDataSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true }, // e.g. 'overall', 'coding', 'raw_data', etc.
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('RankData', RankDataSchema);
