const mongoose = require('mongoose');

const EndpointSchema = new mongoose.Schema({
  provider_name: { type: String, default: 'Primary' },
  input_cost_per_m: { type: Number, required: true }, // Price in USD per 1M tokens
  output_cost_per_m: { type: Number, required: true }, // Price in USD per 1M tokens
  cache_read_cost_per_m: { type: Number, default: 0 }, // Caching discounts
  is_active: { type: Boolean, default: true },
  last_synced_at: { type: Date, default: Date.now }
});

const CapabilitiesSchema = new mongoose.Schema({
  aa_index_score: { type: Number },
  coding_score: { type: Number },
  math_score: { type: Number },
  reasoning_score: { type: Number },
  tokens_per_second: { type: Number },
  time_to_first_token_ms: { type: Number },
  last_synced_at: { type: Date }
});

const ModelSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // The OpenRouter ID (e.g. 'anthropic/claude-3-5-sonnet')
  name: { type: String, required: true },
  developer: { type: String },
  context_length: { type: Number },
  endpoints: [EndpointSchema],
  capabilities: { type: CapabilitiesSchema, default: () => ({}) },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Model', ModelSchema);
