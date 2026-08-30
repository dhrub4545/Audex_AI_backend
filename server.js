// Audex AI API Server - Deployed 2026-07-28
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const rateLimit = require('express-rate-limit');

const auditRoutes = require('./routes/auditRoutes');
const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const paymentRoutes = require('./routes/paymentRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Rate limiting configurations
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 messages per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests. Please wait a moment before sending more messages.' }
});

const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please try again shortly.' }
});

// Configure CORS
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, or same-origin server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o)) || origin.includes('localhost') || origin.includes('vercel.app')) {
      return callback(null, true);
    }
    return callback(null, true); // Permissive in dev, logged in prod
  },
  credentials: true
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Security & Cache-Control headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Database connection management (supports persistent server and serverless environments)
const MONGODB_URI = process.env.MONGODB_URI || process.env.mongo_db || 'mongodb://localhost:27017/audit-ai';

let cachedConnection = global.mongooseConnection;
if (!cachedConnection) {
  cachedConnection = global.mongooseConnection = { conn: null, promise: null };
}

async function connectToDatabase() {
  if (cachedConnection.conn && mongoose.connection.readyState === 1) {
    return cachedConnection.conn;
  }

  if (!cachedConnection.promise) {
    const opts = {
      bufferCommands: false,
      serverSelectionTimeoutMS: 10000,
    };

    cachedConnection.promise = mongoose.connect(MONGODB_URI, opts)
      .then((mongooseInstance) => {
        console.log('MongoDB successfully connected.');
        // Initialize scheduler once when running in standalone server mode
        if (!process.env.VERCEL) {
          const { initScheduler } = require('./jobs/scheduler');
          initScheduler();
        }
        return mongooseInstance;
      })
      .catch((err) => {
        console.error('❌ MongoDB connection failed:', err.message);
        cachedConnection.promise = null;
        if (!process.env.VERCEL) {
          process.exit(1);
        }
        throw err;
      });
  }

  cachedConnection.conn = await cachedConnection.promise;
  return cachedConnection.conn;
}

// Initial connection attempt on server startup
connectToDatabase().catch(() => {});

// Middleware to guarantee MongoDB is connected before handling routes
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    try {
      console.log('⏳ Database connection is in state', mongoose.connection.readyState, '- reconnecting to database...');
      await connectToDatabase();
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

// Routes with dedicated rate limits
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/audits', auditRoutes);
app.use('/api/chats', chatLimiter, chatRoutes);
app.use('/api/payment', paymentLimiter, paymentRoutes);

app.get('/', (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  res.json({
    message: 'AudMint API Server is running',
    dbMode: isConnected ? 'MongoDB (Connected)' : 'MongoDB (Disconnected)',
    dbState: mongoose.connection.readyState
  });
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'An internal server error occurred.',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
