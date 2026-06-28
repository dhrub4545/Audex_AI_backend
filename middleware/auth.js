const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'audex-ai-jwt-secret-key-12345';

// Strictly enforced authentication middleware
const auth = (req, res, next) => {
  const authHeader = req.header('Authorization');
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied. No authorization header provided.' });
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Access denied. Invalid token format.' });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Access denied. Invalid or expired token.' });
  }
};

// Optional authentication middleware (continues even if unauthenticated)
const optionalAuth = (req, res, next) => {
  const authHeader = req.header('Authorization');
  
  if (!authHeader) {
    return next();
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return next();
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
  } catch (err) {
    // Ignore error and proceed as guest user
  }
  next();
};

module.exports = {
  auth,
  optionalAuth
};
