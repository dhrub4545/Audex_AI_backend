const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'audex-ai-jwt-secret-key-12345';



// Helper to generate JWT token
const generateToken = (userId, email) => {
  return jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
};

// Route: User Registration (POST /register)
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate inputs
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Please provide all required fields (name, email, password).' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email address already exists.' });
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      credits: { starter: 1, pro: 0, proMax: 0 }
    });
    await newUser.save();
    console.log('Saved user in MongoDB:', newUser._id);

    // Generate token and return success details
    const token = generateToken(newUser._id, newUser.email);
    res.status(201).json({
      token,
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        credits: newUser.credits
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal Server Error during registration.', details: error.message });
  }
});

// Route: User Login (POST /login)
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Please provide email and password.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Generate token
    const token = generateToken(user._id, user.email);
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        credits: user.credits || { starter: 0, pro: 0, proMax: 0 }
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal Server Error during login.', details: error.message });
  }
});

// Route: Get current user profile details (GET /me)
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      credits: user.credits || { starter: 0, pro: 0, proMax: 0 }
    });
  } catch (error) {
    console.error('Fetch me error:', error);
    res.status(500).json({ error: 'Internal Server Error fetching user profile.' });
  }
});

// Route: Purchase credits (POST /purchase)
router.post('/purchase', auth, async (req, res) => {
  try {
    const { creditType, amount } = req.body;
    if (!creditType || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid purchase details.' });
    }
    if (!['starter', 'pro', 'proMax'].includes(creditType)) {
      return res.status(400).json({ error: 'Invalid credit type.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!user.credits) user.credits = { starter: 0, pro: 0, proMax: 0 };
    user.credits[creditType] = (user.credits[creditType] || 0) + amount;
    await user.save();

    res.json({
      message: 'Purchase successful.',
      credits: user.credits
    });
  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({ error: 'Internal Server Error during purchase.' });
  }
});

module.exports = router;
