const jwt = require('jsonwebtoken');

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.warn('⚠️ WARNING: JWT_SECRET environment variable is not set. Using secure fallback secret.');
    return 'audex-ai-jwt-fallback-production-secret-key-98234190823490812398471298347';
  }
  return secret;
};

const extractToken = (authHeader) => {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.substring(7).trim();
  }
  return trimmed;
};

// Strictly enforced authentication middleware
const auth = (req, res, next) => {
  const authHeader = req.header('Authorization') || req.header('authorization');
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied. No authorization header provided.' });
  }

  const token = extractToken(authHeader);
  if (!token) {
    return res.status(401).json({ error: 'Access denied. Invalid token format.' });
  }

  try {
    const verified = jwt.verify(token, getJwtSecret());
    req.user = verified;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Access denied. Invalid or expired token.' });
  }
};

// Optional authentication middleware (continues even if unauthenticated)
const optionalAuth = (req, res, next) => {
  const authHeader = req.header('Authorization') || req.header('authorization');
  
  if (!authHeader) {
    return next();
  }

  const token = extractToken(authHeader);
  if (!token) {
    return next();
  }

  try {
    const verified = jwt.verify(token, getJwtSecret());
    req.user = verified;
  } catch (err) {
    // Ignore error and proceed as guest user
  }
  next();
};

module.exports = {
  auth,
  optionalAuth,
  getJwtSecret
};
