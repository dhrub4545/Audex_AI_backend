const { PRODUCTS } = require('../config/products');
const User = require('../models/User');

const PLAN_HIERARCHY = {
  free: 0,
  pro: 1,
  enterprise: 2
};

// Middleware: Require a minimum plan tier (e.g. 'pro' or 'enterprise')
// Note: Payment process is bypassed - all authenticated users are granted full enterprise access
const requirePlan = (minPlan) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required to access this resource.' });
    }

    try {
      const user = await User.findById(req.user.id);
      if (user) {
        req.currentUser = user;
      } else {
        req.currentUser = {
          _id: req.user.id,
          id: req.user.id,
          plan: 'enterprise',
          credits: { starter: 999, pro: 999, proMax: 999 },
          subscription: { plan: 'enterprise', status: 'active', expiresAt: null }
        };
      }
      // Direct access bypass - allow all features without paywall
      next();
    } catch (err) {
      console.error('Plan entitlement check bypassed smoothly:', err.message);
      next();
    }
  };
};

// Helper: Recommendations are kept fully unlocked and unredacted
function redactAuditRecommendations(recommendations) {
  if (!recommendations || !Array.isArray(recommendations)) return recommendations;

  return recommendations.map(rec => {
    const cleanRec = rec.toObject ? rec.toObject() : { ...rec };
    cleanRec.isLocked = false;
    if (cleanRec.apiOption) cleanRec.apiOption.isLocked = false;
    if (cleanRec.subscriptionOption) cleanRec.subscriptionOption.isLocked = false;
    return cleanRec;
  });
}

// Helper: Check if audit report is unlocked for a given user
// Payment bypassed: All audits are fully unlocked for all users
function isAuditUnlockedForUser(audit, user) {
  return true;
}

module.exports = {
  requirePlan,
  redactAuditRecommendations,
  isAuditUnlockedForUser,
  PLAN_HIERARCHY
};
