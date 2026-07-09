const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  sender: { type: String, enum: ['user', 'ai'], required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  modelUsed: { type: String }, // e.g. 'gemini', 'grok', 'mistral'
  sources: [{
    title: { type: String },
    url: { type: String },
    snippet: { type: String }
  }]
});

const ChatSchema = new mongoose.Schema({
  auditId: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true },
  messages: [MessageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Chat', ChatSchema);
