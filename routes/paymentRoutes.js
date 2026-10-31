const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Audit = require('../models/Audit');
const PaymentTransaction = require('../models/PaymentTransaction');
const { auth } = require('../middleware/auth');
const { PRODUCTS, UPI_CONFIG, USD_TO_INR_RATE } = require('../config/products');

// Route: Get Public Product Catalog & Entitlements (GET /api/payment/plans)
router.get('/plans', (req, res) => {
  try {
    res.json({
      currency: 'INR',
      baseCurrency: 'USD',
      usdToInrRate: USD_TO_INR_RATE,
      plans: PRODUCTS,
      upiConfig: {
        merchantVpa: UPI_CONFIG.merchantVpa,
        merchantName: UPI_CONFIG.merchantName,
        isRazorpayActive: false,
        allPlansFree: true
      }
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to retrieve subscription plans.' });
  }
});

// Route: Create Order (POST /api/payment/create-upi-order) - Payment Bypassed
router.post('/create-upi-order', auth, async (req, res) => {
  try {
    const { planId = 'enterprise', auditId } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const product = PRODUCTS[planId] || PRODUCTS.enterprise;

    let resolvedAudit = null;
    if (planId === 'single_unlock' && auditId) {
      resolvedAudit = await Audit.findById(auditId);
    }

    // Generate unique internal tracking Order ID
    const randomHex = Math.random().toString(36).substring(2, 7).toUpperCase();
    const orderId = `AUDEX_FREE_${Date.now()}_${randomHex}`;

    // Record completed transaction in MongoDB directly
    const transaction = new PaymentTransaction({
      userId: user._id,
      orderId,
      productId: planId,
      auditId: resolvedAudit ? resolvedAudit._id : null,
      amountInr: 0,
      amountUsd: 0,
      currency: 'INR',
      paymentMethod: 'Instant Free Activation',
      status: 'completed',
      utrNumber: 'FREE_' + Date.now(),
      verifiedAt: new Date()
    });
    await transaction.save();

    // Instantly activate plan or unlock audit on user
    if (planId === 'single_unlock' && resolvedAudit) {
      if (!user.unlockedAudits) user.unlockedAudits = [];
      const auditIdStr = resolvedAudit._id.toString();
      if (!user.unlockedAudits.some(id => id.toString() === auditIdStr)) {
        user.unlockedAudits.push(resolvedAudit._id);
      }
    } else {
      user.plan = planId === 'free' ? 'free' : 'enterprise';
      user.subscription = {
        plan: user.plan,
        status: 'active',
        startedAt: new Date(),
        expiresAt: null,
        paymentMethod: 'Free Access Mode',
        lastOrderId: orderId
      };
    }
    await user.save();

    res.json({
      orderId,
      internalOrderId: orderId,
      razorpayOrderId: null,
      razorpayKeyId: null,
      isRazorpayActive: false,
      instantActivated: true,
      product: {
        id: product.id,
        name: product.name,
        badge: product.badge,
        priceInr: 0,
        priceUsd: 0,
        billingInterval: product.billingInterval
      },
      user: {
        name: user.name,
        email: user.email,
        plan: user.plan
      },
      amountInr: 0,
      amountUsd: 0,
      currency: 'INR',
      auditId: resolvedAudit ? resolvedAudit._id : null
    });

  } catch (error) {
    console.error('Create order error (bypassed):', error);
    res.status(500).json({ error: 'Failed to process order.', details: error.message });
  }
});

// Route: Verify Payment (POST /api/payment/verify-upi-payment) - Instant Activation
router.post('/verify-upi-payment', auth, async (req, res) => {
  try {
    const { planId = 'enterprise', auditId } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (planId === 'single_unlock' && auditId) {
      if (!user.unlockedAudits) user.unlockedAudits = [];
      const auditIdStr = auditId.toString();
      if (!user.unlockedAudits.some(id => id.toString() === auditIdStr)) {
        user.unlockedAudits.push(auditId);
      }
    } else {
      user.plan = 'enterprise';
      user.subscription = {
        plan: 'enterprise',
        status: 'active',
        startedAt: new Date(),
        expiresAt: null,
        paymentMethod: 'Free Access Mode',
        lastOrderId: 'AUDEX_FREE_' + Date.now()
      };
    }
    await user.save();

    res.json({
      success: true,
      message: '🎉 All features and models are fully unlocked and active!',
      product: {
        id: 'enterprise',
        name: 'Enterprise Plan',
        priceInr: 0
      },
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        subscription: user.subscription,
        unlockedAudits: user.unlockedAudits,
        credits: user.credits || { starter: 999, pro: 999, proMax: 999 }
      }
    });

  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Failed to activate plan.', details: error.message });
  }
});

// Route: Webhook placeholder (POST /api/payment/webhook)
router.post('/webhook', async (req, res) => {
  res.json({ status: 'ok', message: 'Payment gateway bypassed.' });
});

// Route: Get Live Subscription Status (GET /api/payment/subscription-status)
router.get('/subscription-status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const currentPlan = 'enterprise';
    const product = PRODUCTS.enterprise;

    const recentTransactions = await PaymentTransaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      plan: currentPlan,
      productDetails: product,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt
      },
      subscription: {
        plan: 'enterprise',
        status: 'active',
        startedAt: user.createdAt || new Date(),
        expiresAt: null,
        paymentMethod: 'Free Enterprise Access'
      },
      unlockedAudits: user.unlockedAudits || [],
      recentTransactions
    });

  } catch (error) {
    console.error('Subscription status error:', error);
    res.status(500).json({ error: 'Failed to fetch subscription status.' });
  }
});

// Route: Cancel Subscription (POST /api/payment/cancel-subscription)
router.post('/cancel-subscription', auth, async (req, res) => {
  try {
    res.json({
      message: 'Your Enterprise access remains active with unlimited benefits.',
      subscription: {
        plan: 'enterprise',
        status: 'active',
        expiresAt: null
      }
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to process cancel request.' });
  }
});

module.exports = router;
