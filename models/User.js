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
    trim: true
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
      default: 0
    },
    pro: {
      type: Number,
      default: 0
    },
    proMax: {
      type: Number,
      default: 0
    }
  }
});

module.exports = mongoose.model('User', UserSchema);
