const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const auditRoutes = require('./routes/auditRoutes');
const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || process.env.mongo_db || 'mongodb://localhost:27017/audit-ai';

mongoose.connect(MONGODB_URI)
.then(() => {
  console.log('MongoDB successfully connected.');
  // Start scheduler
  const { initScheduler } = require('./jobs/scheduler');
  initScheduler();
})
.catch((err) => {
  console.error('❌ MongoDB connection failed:', err.message);
  if (!process.env.VERCEL) {
    process.exit(1);
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/audits', auditRoutes);
app.use('/api/chats', chatRoutes);

app.get('/', (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  res.json({
    message: 'AudMint API Server is running',
    dbMode: isConnected ? 'MongoDB (Connected)' : 'MongoDB (Disconnected)',
    dbState: mongoose.connection.readyState
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
