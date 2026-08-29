const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Audit = require('../models/Audit');
const { auth } = require('../middleware/auth');
const axios = require('axios');

const JWT_SECRET = process.env.JWT_SECRET || 'audex-ai-jwt-secret-key-12345';



// Email regex validator
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper to generate JWT token
const generateToken = (userId, email) => {
  return jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
};

// Route: User Registration (POST /register)
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate inputs
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Please provide a valid name.' });
    }

    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    if (password.length > 128) {
      return res.status(400).json({ error: 'Password cannot exceed 128 characters.' });
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
        credits: newUser.credits,
        plan: newUser.plan || 'free',
        unlockedAudits: newUser.unlockedAudits || []
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

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Please provide email and password.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !user.password) {
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
        credits: user.credits || { starter: 0, pro: 0, proMax: 0 },
        plan: user.plan || 'free',
        unlockedAudits: user.unlockedAudits || []
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
      credits: user.credits || { starter: 0, pro: 0, proMax: 0 },
      plan: user.plan || 'free',
      unlockedAudits: user.unlockedAudits || []
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

// Route: Subscribe to a plan (POST /subscribe)
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !['free', 'pro', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan selection.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.plan = plan;
    await user.save();

    res.json({
      message: `Successfully subscribed to ${plan} plan.`,
      plan: user.plan,
      unlockedAudits: user.unlockedAudits || [],
      credits: user.credits
    });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Internal Server Error during subscription.' });
  }
});

// Route: Unlock a specific audit report (POST /unlock-audit)
router.post('/unlock-audit', auth, async (req, res) => {
  try {
    const { auditId } = req.body;
    if (!auditId) {
      return res.status(400).json({ error: 'Missing audit ID.' });
    }

    const audit = await Audit.findById(auditId);
    if (!audit) {
      return res.status(404).json({ error: 'Audit report not found.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!user.unlockedAudits) {
      user.unlockedAudits = [];
    }

    const auditIdStr = auditId.toString();
    const isAlreadyUnlocked = user.unlockedAudits.some(id => id.toString() === auditIdStr);

    if (!isAlreadyUnlocked) {
      user.unlockedAudits.push(auditId);
      await user.save();
    }

    res.json({
      message: 'Audit report unlocked successfully.',
      plan: user.plan,
      unlockedAudits: user.unlockedAudits,
      credits: user.credits
    });
  } catch (error) {
    console.error('Unlock audit error:', error);
    res.status(500).json({ error: 'Internal Server Error during report unlock.' });
  }
});

// Route: Initiate Google OAuth (GET /google)
router.get('/google', (req, res) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  
  if (!googleClientId || !redirectUri) {
    return res.status(500).json({ error: 'Google OAuth is not configured on the server. Missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI.' });
  }

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(googleClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&prompt=select_account`;
  res.redirect(authUrl);
});

// Route: Google Callback (GET /google/callback)
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is missing.' });
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // 1. Exchange auth code for tokens
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const { access_token } = tokenResponse.data;

    // 2. Fetch user profile info using the access token
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    const { sub, email, name, picture } = userResponse.data;

    if (!email) {
      return res.status(400).json({ error: 'Google did not return an email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 3. Find or create user in MongoDB
    let user = await User.findOne({ googleId: sub });
    
    if (!user) {
      // Check if user exists by email (local signup previously)
      user = await User.findOne({ email: normalizedEmail });
      if (user) {
        // Link Google ID to existing account
        user.googleId = sub;
        await user.save();
      } else {
        // Create new account (Google signup)
        user = new User({
          name: name || 'Google User',
          email: normalizedEmail,
          googleId: sub,
          credits: { starter: 1, pro: 0, proMax: 0 } // Give starter credits
        });
        await user.save();
        console.log('Created new user via Google OAuth:', user._id);
      }
    }

    // 4. Generate local application JWT token
    const token = generateToken(user._id, user.email);

    // 5. Redirect browser back to the frontend with query parameters
    const redirectUrl = `${frontendUrl}/?google_token=${token}&google_user_id=${user._id}&google_user_name=${encodeURIComponent(user.name)}&google_user_email=${encodeURIComponent(user.email)}&google_user_plan=${user.plan || 'free'}&google_user_unlocked_audits=${(user.unlockedAudits || []).map(id => id.toString()).join(',')}`;
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('Google OAuth error:', error.response ? error.response.data : error.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // Redirect back to frontend login with user-safe error message
    const userMessage = error.response?.data?.error_description || error.response?.data?.error || 'Authentication with Google failed. Please try again.';
    res.redirect(`${frontendUrl}/?google_error=${encodeURIComponent(userMessage)}`);
  }
});

// Route: Initiate GitHub OAuth (GET /github)
router.get('/github', (req, res) => {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = process.env.GITHUB_REDIRECT_URI;

  if (!githubClientId || !redirectUri) {
    return res.status(500).json({ error: 'GitHub OAuth is not configured on the server. Missing GITHUB_CLIENT_ID or GITHUB_REDIRECT_URI.' });
  }

  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(githubClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user:email`;
  res.redirect(authUrl);
});

// Route: GitHub Callback (GET /github/callback)
router.get('/github/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is missing.' });
    }

    const githubClientId = process.env.GITHUB_CLIENT_ID;
    const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
    const redirectUri = process.env.GITHUB_REDIRECT_URI;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // 1. Exchange authorization code for access token
    const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: githubClientId,
      client_secret: githubClientSecret,
      code,
      redirect_uri: redirectUri
    }, {
      headers: {
        Accept: 'application/json'
      }
    });

    const { access_token, error: tokenError, error_description } = tokenResponse.data;
    if (tokenError) {
      throw new Error(error_description || tokenError);
    }

    if (!access_token) {
      throw new Error('No access token returned from GitHub.');
    }

    // 2. Fetch user profile from GitHub
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `token ${access_token}`,
        'User-Agent': 'Audex-AI-Backend'
      }
    });

    const githubProfile = userResponse.data;
    const githubId = String(githubProfile.id);
    let email = githubProfile.email;

    // 3. Fetch user emails if primary email is private / null in profile
    if (!email) {
      try {
        const emailsResponse = await axios.get('https://api.github.com/user/emails', {
          headers: {
            Authorization: `token ${access_token}`,
            'User-Agent': 'Audex-AI-Backend'
          }
        });
        
        if (Array.isArray(emailsResponse.data) && emailsResponse.data.length > 0) {
          const primaryEmailObj = emailsResponse.data.find(e => e.primary && e.verified) || 
                                  emailsResponse.data.find(e => e.primary) ||
                                  emailsResponse.data[0];
          email = primaryEmailObj.email;
        }
      } catch (emailErr) {
        console.error('Failed to fetch user emails from GitHub:', emailErr.message);
      }
    }

    if (!email) {
      return res.status(400).json({ error: 'GitHub did not return a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 4. Find or create user in MongoDB
    let user = await User.findOne({ githubId });

    if (!user) {
      // Check if user exists by email (local signup previously)
      user = await User.findOne({ email: normalizedEmail });
      if (user) {
        // Link GitHub ID to existing account
        user.githubId = githubId;
        await user.save();
      } else {
        // Create new account (GitHub signup)
        user = new User({
          name: githubProfile.name || githubProfile.login || 'GitHub User',
          email: normalizedEmail,
          githubId,
          credits: { starter: 1, pro: 0, proMax: 0 } // Give starter credits
        });
        await user.save();
        console.log('Created new user via GitHub OAuth:', user._id);
      }
    }

    // 5. Generate local JWT token
    const token = generateToken(user._id, user.email);

    // 6. Redirect back to frontend with session query parameters
    const redirectUrl = `${frontendUrl}/?github_token=${token}&github_user_id=${user._id}&github_user_name=${encodeURIComponent(user.name)}&github_user_email=${encodeURIComponent(user.email)}&github_user_plan=${user.plan || 'free'}&github_user_unlocked_audits=${(user.unlockedAudits || []).map(id => id.toString()).join(',')}`;
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('GitHub OAuth error:', error.response ? error.response.data : error.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const userMessage = error.response?.data?.error_description || error.message || 'Authentication with GitHub failed. Please try again.';
    res.redirect(`${frontendUrl}/?github_error=${encodeURIComponent(userMessage)}`);
  }
});

module.exports = router;
