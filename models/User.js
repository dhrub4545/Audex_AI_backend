const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  password: {
    type: String,
    required: false
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true
  },
  githubId: {
    type: String,
    unique: true,
    sparse: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  credits: {
    starter: {
      type: Number,
      default: 999
    },
    pro: {
      type: Number,
      default: 999
    },
    proMax: {
      type: Number,
      default: 999
    }
  },
  plan: {
    type: String,
    enum: ['free', 'pro', 'enterprise'],
    default: 'enterprise'
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'enterprise'
    },
    status: {
      type: String,
      enum: ['active', 'trialing', 'canceled', 'expired', 'none'],
      default: 'active'
    },
    startedAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date,
      default: null
    },
    paymentMethod: {
      type: String,
      default: 'Included / Free Access'
    },
    lastOrderId: {
      type: String,
      default: null
    }
  },
  unlockedAudits: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Audit'
  }]
});

module.exports = mongoose.model('User', UserSchema);
