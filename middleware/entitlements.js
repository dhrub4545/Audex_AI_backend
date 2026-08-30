const { PRODUCTS } = require('../config/products');
const User = require('../models/User');

const PLAN_HIERARCHY = {
  free: 0,
  pro: 1,
  enterprise: 2
};

// Middleware: Require a minimum plan tier (e.g. 'pro' or 'enterprise')
const requirePlan = (minPlan) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required to access this resource.' });
    }

    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const userPlan = (user.plan || 'free').toLowerCase();
      
      // Check if subscription has not expired
      let isSubscriptionExpired = false;
      if (user.subscription && user.subscription.expiresAt) {
        isSubscriptionExpired = new Date(user.subscription.expiresAt) < new Date();
      }

      const plan = isSubscriptionExpired ? 'free' : userPlan;
      const effectiveLevel = PLAN_HIERARCHY[plan] || 0;

      const requiredLevel = PLAN_HIERARCHY[minPlan] || 0;

      if (effectiveLevel < requiredLevel) {
        return res.status(403).json({
          error: `Access Denied. The Live Model Auditor requires an active ${minPlan.toUpperCase()} subscription.`,
          currentPlan: userPlan,
          requiredPlan: minPlan,
          upgradeRequired: true
        });
      }

      req.currentUser = user;
      next();
    } catch (err) {
      console.error('Plan entitlement check failed:', err);
      res.status(500).json({ error: 'Failed to verify subscription entitlements.' });
    }
  };
};

// Helper: Redact recommendations for locked audits
function redactAuditRecommendations(recommendations) {
  if (!recommendations || !Array.isArray(recommendations)) return recommendations;

  return recommendations.map(rec => {
    const redactedRec = rec.toObject ? rec.toObject() : { ...rec };
    redactedRec.action = '•••••••• (Locked)';
    redactedRec.isLocked = true;
    
    if (redactedRec.apiOption) {
      redactedRec.apiOption = {
        ...redactedRec.apiOption,
        action: '••••••••',
        planName: '••••••••',
        name: '••••••••',
        limits: '••••••••',
        recommendedModel: '••••••••',
        recommendedProvider: '••••••••',
        statusText: 'Locked'
      };
    }
    
    if (redactedRec.subscriptionOption) {
      redactedRec.subscriptionOption = {
        ...redactedRec.subscriptionOption,
        action: '••••••••',
        planName: '••••••••',
        name: '••••••••',
        limits: '••••••••',
        recommendedModel: '••••••••',
        recommendedProvider: '••••••••',
        statusText: 'Locked'
      };
    }
    
    return redactedRec;
  });
}

// Helper: Check if audit report is unlocked for a given user
function isAuditUnlockedForUser(audit, user) {
  if (!audit) return false;
  const uniqueTools = [...new Set((audit.allocations || []).map(a => a.toolName))];
  const numTools = uniqueTools.length;

  // 1. Up to 2 tools is free for everyone
  if (numTools <= 2) return true;

  if (!user) return false;

  // Check subscription expiration
  let isSubscriptionExpired = false;
  if (user.subscription && user.subscription.expiresAt) {
    isSubscriptionExpired = new Date(user.subscription.expiresAt) < new Date();
  }

  const plan = (user.plan || 'free').toLowerCase();
  const effectivePlan = isSubscriptionExpired ? 'free' : plan;

  // 2. Enterprise has full unlimited access
  if (effectivePlan === 'enterprise') return true;

  // 3. Pro has up to 15 tools unlocked
  if (effectivePlan === 'pro' && numTools <= 15) return true;

  // 4. Single unlock check
  if (user.unlockedAudits && Array.isArray(user.unlockedAudits)) {
    const auditIdStr = audit._id ? audit._id.toString() : audit.id?.toString();
    if (auditIdStr && user.unlockedAudits.some(id => id.toString() === auditIdStr)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  requirePlan,
  redactAuditRecommendations,
  isAuditUnlockedForUser,
  PLAN_HIERARCHY
};
