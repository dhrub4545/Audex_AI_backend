const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const User = require('../models/User');
const Audit = require('../models/Audit');
const PaymentTransaction = require('../models/PaymentTransaction');
const { auth } = require('../middleware/auth');
const { PRODUCTS, UPI_CONFIG, USD_TO_INR_RATE } = require('../config/products');

// Initialize Razorpay Client if credentials exist
const getRazorpayInstance = () => {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (keyId && keySecret) {
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return null;
};

// Route: Get Public Product Catalog & Entitlements (GET /api/payment/plans)
router.get('/plans', (req, res) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    res.json({
      currency: 'INR',
      baseCurrency: 'USD',
      usdToInrRate: USD_TO_INR_RATE,
      plans: PRODUCTS,
      upiConfig: {
        merchantVpa: UPI_CONFIG.merchantVpa,
        merchantName: UPI_CONFIG.merchantName,
        isRazorpayActive: Boolean(keyId)
      }
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to retrieve subscription plans.' });
  }
});

// Route: Create Secure UPI / Razorpay Order (POST /api/payment/create-upi-order)
router.post('/create-upi-order', auth, async (req, res) => {
  try {
    const { planId, auditId } = req.body;

    if (!planId || !PRODUCTS[planId]) {
      return res.status(400).json({ error: 'Invalid subscription plan or product ID.' });
    }

    const product = PRODUCTS[planId];
    if (product.priceInr <= 0) {
      return res.status(400).json({ error: 'Free tier does not require a payment transaction.' });
    }

    let resolvedAudit = null;
    if (planId === 'single_unlock') {
      if (!auditId) {
        return res.status(400).json({ error: 'Audit ID is required for single report unlock.' });
      }
      resolvedAudit = await Audit.findById(auditId);
      if (!resolvedAudit) {
        return res.status(404).json({ error: 'Specified audit report was not found.' });
      }
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    // Generate unique internal tracking Order ID
    const randomHex = Math.random().toString(36).substring(2, 7).toUpperCase();
    const orderId = `AUDEX_UPI_${Date.now()}_${randomHex}`;

    let razorpayOrderId = null;
    const razorpay = getRazorpayInstance();

    if (razorpay) {
      try {
        const rzpOrder = await razorpay.orders.create({
          amount: Math.round(product.priceInr * 100), // amount in paise
          currency: 'INR',
          receipt: orderId,
          notes: {
            userId: user._id.toString(),
            userEmail: user.email,
            planId: product.id,
            auditId: resolvedAudit ? resolvedAudit._id.toString() : ''
          }
        });
        razorpayOrderId = rzpOrder.id;
      } catch (rzpErr) {
        console.error('Razorpay order creation failed:', rzpErr);
      }
    }

    // Record pending transaction in MongoDB
    const transaction = new PaymentTransaction({
      userId: user._id,
      orderId: razorpayOrderId || orderId,
      productId: planId,
      auditId: resolvedAudit ? resolvedAudit._id : null,
      amountInr: product.priceInr,
      amountUsd: product.priceUsd,
      currency: 'INR',
      paymentMethod: 'Razorpay',
      status: 'pending'
    });
    await transaction.save();

    res.json({
      orderId: razorpayOrderId || orderId,
      internalOrderId: orderId,
      razorpayOrderId,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID?.trim() || null,
      isRazorpayActive: Boolean(razorpay && process.env.RAZORPAY_KEY_ID),
      product: {
        id: product.id,
        name: product.name,
        badge: product.badge,
        priceInr: product.priceInr,
        priceUsd: product.priceUsd,
        billingInterval: product.billingInterval
      },
      user: {
        name: user.name,
        email: user.email
      },
      amountInr: product.priceInr,
      amountUsd: product.priceUsd,
      currency: 'INR',
      expiresInMinutes: 15,
      auditId: resolvedAudit ? resolvedAudit._id : null
    });

  } catch (error) {
    console.error('Create UPI order error:', error);
    res.status(500).json({ error: 'Failed to initiate secure UPI payment order.', details: error.message });
  }
});

// Route: Strictly Verify Razorpay / Bank Cryptographic Payment (POST /api/payment/verify-upi-payment)
router.post('/verify-upi-payment', auth, async (req, res) => {
  try {
    const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature, utrNumber } = req.body;

    if (!orderId && !razorpayOrderId) {
      return res.status(400).json({ error: 'Order ID is required for verification.' });
    }

    const queryOrderId = razorpayOrderId || orderId;

    // Find pending transaction in MongoDB
    const transaction = await PaymentTransaction.findOne({
      orderId: queryOrderId,
      userId: req.user.id
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Payment transaction record not found in system.' });
    }

    if (transaction.status === 'completed') {
      const user = await User.findById(req.user.id).select('-password');
      return res.json({
        message: 'Payment already verified and active.',
        plan: user.plan,
        subscription: user.subscription,
        unlockedAudits: user.unlockedAudits,
        transaction
      });
    }

    const razorpay = getRazorpayInstance();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

    // ── STRICT CRYPTOGRAPHIC VERIFICATION ────────────────────────────
    if (razorpay && keySecret) {
      if (!razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({
          error: 'Missing Razorpay payment proof. Payment has not been completed with the bank.'
        });
      }

      // 1. Verify HMAC-SHA256 Signature generated by Razorpay
      const signBody = razorpayOrderId + '|' + razorpayPaymentId;
      const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(signBody.toString())
        .digest('hex');

      if (expectedSignature !== razorpaySignature) {
        console.error('❌ Cryptographic signature mismatch! Attempted unauthorized payment upgrade.');
        return res.status(400).json({
          error: 'Payment signature verification failed. Unauthorized or tampered transaction.'
        });
      }

      // 2. Fetch payment directly from Razorpay Bank API to confirm amount and captured status
      try {
        const paymentDetails = await razorpay.payments.fetch(razorpayPaymentId);
        if (!paymentDetails || (paymentDetails.status !== 'captured' && paymentDetails.status !== 'authorized')) {
          return res.status(400).json({
            error: `Payment is not in captured status (Current status: ${paymentDetails?.status}).`
          });
        }
      } catch (fetchErr) {
        console.error('Failed to verify payment with Razorpay API:', fetchErr);
        return res.status(400).json({
          error: 'Could not verify payment capture status with banking gateway.'
        });
      }
    } else {
      return res.status(400).json({
        error: 'Razorpay API credentials are not configured in backend .env. Please configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const product = PRODUCTS[transaction.productId];
    if (!product) {
      return res.status(400).json({ error: 'Invalid product for this transaction.' });
    }

    // Apply product entitlements after verified payment
    if (product.id === 'pro' || product.id === 'enterprise') {
      user.plan = product.id;
      user.subscription = {
        plan: product.id,
        status: 'active',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day active period
        paymentMethod: 'UPI / Razorpay',
        lastOrderId: transaction.orderId
      };
    } else if (product.id === 'single_unlock' && transaction.auditId) {
      if (!user.unlockedAudits) {
        user.unlockedAudits = [];
      }
      const auditIdStr = transaction.auditId.toString();
      if (!user.unlockedAudits.some(id => id.toString() === auditIdStr)) {
        user.unlockedAudits.push(transaction.auditId);
      }
    }

    await user.save();

    // Mark transaction completed in MongoDB
    transaction.status = 'completed';
    transaction.utrNumber = razorpayPaymentId || utrNumber || 'RZP_' + Date.now();
    transaction.verifiedAt = new Date();
    await transaction.save();

    console.log(`[Payment Verified] User ${user.email} successfully upgraded to ${product.name} (Payment ID: ${transaction.utrNumber})`);

    res.json({
      success: true,
      message: `🎉 Payment successfully verified! Your ${product.name} is now active.`,
      product: {
        id: product.id,
        name: product.name,
        priceInr: product.priceInr
      },
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        subscription: user.subscription,
        unlockedAudits: user.unlockedAudits,
        credits: user.credits
      },
      transaction: {
        orderId: transaction.orderId,
        amountInr: transaction.amountInr,
        utrNumber: transaction.utrNumber,
        verifiedAt: transaction.verifiedAt
      }
    });

  } catch (error) {
    console.error('Verify UPI payment error:', error);
    res.status(500).json({ error: 'Failed to verify payment transaction.', details: error.message });
  }
});

// Route: Razorpay Server-to-Server Webhook (POST /api/payment/webhook)
router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
    const signature = req.headers['x-razorpay-signature'];

    if (!webhookSecret) {
      console.warn('⚠️ Webhook received but RAZORPAY_WEBHOOK_SECRET is not configured on server.');
      return res.status(503).json({ error: 'Webhook processing disabled. RAZORPAY_WEBHOOK_SECRET not configured.' });
    }

    if (!signature) {
      console.error('❌ Webhook received without x-razorpay-signature header.');
      return res.status(401).json({ error: 'Missing x-razorpay-signature header.' });
    }

    const rawPayload = req.rawBody ? req.rawBody : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const shasum = crypto.createHmac('sha256', webhookSecret);
    shasum.update(rawPayload);
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      console.error('❌ Webhook HMAC-SHA256 signature verification failed.');
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const event = payload.event;

    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;

      if (orderId) {
        const transaction = await PaymentTransaction.findOne({ orderId });
        if (transaction && transaction.status !== 'completed') {
          const user = await User.findById(transaction.userId);
          const product = PRODUCTS[transaction.productId];

          if (user && product) {
            if (product.id === 'pro' || product.id === 'enterprise') {
              user.plan = product.id;
              user.subscription = {
                plan: product.id,
                status: 'active',
                startedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                paymentMethod: 'UPI / Razorpay',
                lastOrderId: orderId
              };
            } else if (product.id === 'single_unlock' && transaction.auditId) {
              if (!user.unlockedAudits) user.unlockedAudits = [];
              const auditIdStr = transaction.auditId.toString();
              if (!user.unlockedAudits.some(id => id.toString() === auditIdStr)) {
                user.unlockedAudits.push(transaction.auditId);
              }
            }
            await user.save();

            transaction.status = 'completed';
            transaction.utrNumber = paymentEntity.id;
            transaction.verifiedAt = new Date();
            await transaction.save();

            console.log(`[Webhook Activated] Plan ${product.name} automatically activated for ${user.email}`);
          }
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (webhookErr) {
    console.error('Webhook error:', webhookErr);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Route: Get Live Subscription Status (GET /api/payment/subscription-status)
router.get('/subscription-status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    let currentPlan = (user.plan || 'free').toLowerCase();

    // Check subscription timeline and handle expired plans gracefully
    if (currentPlan === 'pro' || currentPlan === 'enterprise') {
      if (user.subscription && user.subscription.expiresAt) {
        if (new Date(user.subscription.expiresAt) < new Date()) {
          // Subscription has reached end of billing cycle
          user.subscription.status = 'expired';
          user.plan = 'free';
          currentPlan = 'free';
          await user.save();
        } else if (!user.subscription.status || user.subscription.status === 'none') {
          user.subscription.status = 'active';
          await user.save();
        }
      } else {
        // Initialize timeline for paid accounts missing expiresAt
        const startedAt = user.subscription?.startedAt || user.createdAt || new Date();
        const expiresAt = new Date(new Date(startedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
        const isStillActive = expiresAt > new Date();
        user.subscription = {
          plan: currentPlan,
          status: isStillActive ? (user.subscription?.status && user.subscription.status !== 'none' ? user.subscription.status : 'active') : 'expired',
          startedAt,
          expiresAt,
          paymentMethod: user.subscription?.paymentMethod || 'UPI / Gateway',
          lastOrderId: user.subscription?.lastOrderId || 'AUDEX_SUB_' + user._id.toString().substring(0, 8)
        };
        if (!isStillActive) {
          user.plan = 'free';
          currentPlan = 'free';
        }
        await user.save();
      }
    }

    const product = PRODUCTS[currentPlan] || PRODUCTS.free;

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
      subscription: user.subscription || {
        plan: currentPlan,
        status: currentPlan === 'free' ? 'none' : 'active',
        expiresAt: null
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
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.subscription) {
      user.subscription.status = 'canceled';
      await user.save();
    }

    res.json({
      message: 'Subscription has been canceled. Your benefits remain active until the end of the current billing cycle.',
      subscription: user.subscription
    });

  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

module.exports = router;
