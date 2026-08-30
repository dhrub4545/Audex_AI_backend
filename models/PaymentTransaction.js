const mongoose = require('mongoose');

const PaymentTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  productId: {
    type: String,
    required: true,
    enum: ['pro', 'enterprise', 'single_unlock']
  },
  auditId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Audit',
    default: null
  },
  amountInr: {
    type: Number,
    required: true
  },
  amountUsd: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'INR'
  },
  paymentMethod: {
    type: String,
    default: 'UPI'
  },
  upiVpa: {
    type: String,
    default: null
  },
  utrNumber: {
    type: String,
    default: null,
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
    index: true
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('PaymentTransaction', PaymentTransactionSchema);
