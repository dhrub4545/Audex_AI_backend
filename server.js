const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const auditRoutes = require('./routes/auditRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || process.env.mongo_db || 'mongodb://localhost:27017/audit-ai';

mongoose.connect(MONGODB_URI)
.then(() => {
  console.log('MongoDB successfully connected to:', MONGODB_URI);
  // Start scheduler
  const { initScheduler } = require('./jobs/scheduler');
  initScheduler();
})
.catch((err) => {
  console.error('❌ MongoDB connection failed. Server shutting down:', err.message);
  process.exit(1);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/audits', auditRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'AudMint API Server is running',
    dbMode: 'MongoDB (Connected)'
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
