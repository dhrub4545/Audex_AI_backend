// Audex AI API Server - Deployed 2026-07-28
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

// Prevent Vercel Edge CDN & browser response caching for API routes
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || process.env.mongo_db || 'mongodb://localhost:27017/audit-ai';

let connectionPromise = mongoose.connect(MONGODB_URI)
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
  throw err; // Propagate error for serverless requests
});

// Middleware to guarantee MongoDB is connected before handling routes
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    try {
      console.log('⏳ Database connection is in state', mongoose.connection.readyState, '- awaiting connectionPromise...');
      await connectionPromise;
      next();
    } catch (err) {
      console.error('❌ Request blocked by database connection failure:', err.message);
      res.status(500).json({ 
        error: 'Database connection failed. Please check backend logs and MongoDB Atlas Network IP access settings.',
        details: err.message 
      });
    }
  } else {
    next();
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
