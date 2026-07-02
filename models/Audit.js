const mongoose = require('mongoose');

const AllocationSchema = new mongoose.Schema({
  type: { type: String, enum: ['subscription', 'api'], required: true },
  toolName: { type: String, required: true },
  plan: { type: String },
  seats: { type: Number, default: 1 },
  purpose: { type: String, required: true },
  modelId: { type: String },
  inputTokens: { type: Number },
  outputTokens: { type: Number },
  pricePerSeat: { type: Number },
  baselineModels: [{ type: String }]
});

const OptionSchema = new mongoose.Schema({
  cost: { type: Number, required: true },
  savings: { type: Number, required: true },
  action: { type: String, required: true },
  planName: { type: String },
  limits: { type: String },
  name: { type: String },
  modelId: { type: String },
  statusText: { type: String },
  includedModels: [{ type: String }]
});

const RecommendationSchema = new mongoose.Schema({
  tool: { type: String, required: true },
  issue: { type: String, required: true },
  action: { type: String, required: true },
  monthlySavings: { type: Number, required: true },
  apiOption: { type: OptionSchema, required: false },
  subscriptionOption: { type: OptionSchema, required: false }
});

const AuditSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  teamSize: { type: Number, required: false },
  useCase: { type: String, required: false },
  optimizationGoal: { type: String, default: 'performance' },
  costCutPercentage: { type: Number, default: 50 },
  totalCurrentCost: { type: Number },
  allocations: [AllocationSchema],
  savings: {
    totalMonthly: { type: Number, required: true },
    totalAnnual: { type: Number, required: true },
    apiMonthly: { type: Number },
    apiAnnual: { type: Number },
    subMonthly: { type: Number },
    subAnnual: { type: Number },
    recommendations: [RecommendationSchema]
  },
  createdAt: { type: Date, default: Date.now }
});

// Optimize user audits lookup and sorting queries
AuditSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Audit', AuditSchema);

