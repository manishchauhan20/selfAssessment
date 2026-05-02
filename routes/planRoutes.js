const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');

const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanPayment = require('../models/PlanPayment');
const {
  DEFAULT_FREE_EXAM_LIMIT,
  getAvailablePlans,
  getUserQuota,
  purchasePlanCredits,
} = require('../utils/quotaManager');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'mySecretKey';
const FRONTEND_BASE_URL = String(process.env.FRONTEND_BASE_URL || 'http://localhost:3000').trim();
const BASE_URL = String(process.env.BASE_URL || 'http://localhost:5000').trim();
const PHONEPE_MODE = String(process.env.PHONEPE_MODE || 'uat').trim().toLowerCase();
const PHONEPE_CLIENT_ID = String(process.env.PHONEPE_CLIENT_ID || '').trim();
const PHONEPE_CLIENT_SECRET = String(process.env.PHONEPE_CLIENT_SECRET || '').trim();

function getPhonePeTokenUrl() {
  if (PHONEPE_MODE === 'prod' || PHONEPE_MODE === 'production') {
    return 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';
  }
  return 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';
}

function getPhonePePayUrl() {
  if (PHONEPE_MODE === 'prod' || PHONEPE_MODE === 'production') {
    return 'https://api.phonepe.com/apis/pg/checkout/v2/pay';
  }
  return 'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay';
}

function getPhonePeStatusUrl(orderId) {
  if (PHONEPE_MODE === 'prod' || PHONEPE_MODE === 'production') {
    return `https://api.phonepe.com/apis/pg/checkout/v2/order/${encodeURIComponent(orderId)}/status`;
  }
  return `https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order/${encodeURIComponent(orderId)}/status`;
}

function ensurePhonePeConfigured() {
  if (!PHONEPE_CLIENT_ID || !PHONEPE_CLIENT_SECRET) {
    const error = new Error('PhonePe client credentials are not configured on server.');
    error.code = 'phonepe_not_configured';
    throw error;
  }
}

async function getPhonePeAccessToken() {
  ensurePhonePeConfigured();

  const response = await axios.post(
    getPhonePeTokenUrl(),
    new URLSearchParams({
      client_id: PHONEPE_CLIENT_ID,
      client_version: '1',
      client_secret: PHONEPE_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return String(response?.data?.access_token || '').trim();
}

async function phonePeCreatePayment({ orderId, amountPaise, planId }) {
  const token = await getPhonePeAccessToken();
  if (!token) {
    const error = new Error('PhonePe token was not received.');
    error.code = 'phonepe_token_missing';
    throw error;
  }

  const payload = {
    merchantOrderId: String(orderId),
    amount: Number(amountPaise),
    paymentFlow: {
      type: 'PG_CHECKOUT',
      merchantUrls: {
        redirectUrl: `${FRONTEND_BASE_URL}/buy-plan?gateway=phonepe&planId=${encodeURIComponent(
          String(planId)
        )}&orderId=${encodeURIComponent(String(orderId))}`,
      },
    },
  };

  const response = await axios.post(getPhonePePayUrl(), payload, {
    headers: {
      Authorization: `O-Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const data = response?.data || {};
  const paymentUrl = String(data?.data?.redirectUrl || data?.redirectUrl || '').trim();
  if (!paymentUrl) {
    const error = new Error('PhonePe payment URL was not received.');
    error.code = 'phonepe_redirect_missing';
    error.details = data;
    throw error;
  }

  return { paymentUrl, raw: data };
}

async function phonePeCheckStatus(orderId) {
  const token = await getPhonePeAccessToken();
  if (!token) {
    const error = new Error('PhonePe token was not received.');
    error.code = 'phonepe_token_missing';
    throw error;
  }

  const response = await axios.get(getPhonePeStatusUrl(orderId), {
    headers: {
      Authorization: `O-Bearer ${token}`,
    },
  });

  return response?.data || {};
}

function getAuthUserFromRequest(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      id: String(decoded?.id || ''),
      role: String(decoded?.role || ''),
    };
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const authUser = getAuthUserFromRequest(req);
  if (!authUser?.id || !mongoose.Types.ObjectId.isValid(authUser.id)) {
    return res.status(401).json({ error: 'Unauthorized. Please login again.' });
  }
  req.authUser = authUser;
  return next();
}

router.get('/', async (req, res) => {
  try {
    const plans = await getAvailablePlans();
    return res.json({
      freeExamLimit: DEFAULT_FREE_EXAM_LIMIT,
      gateway: 'phonepe',
      plans,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch plans.', message: error?.message || error });
  }
});

router.get('/quota', requireAuth, async (req, res) => {
  try {
    const quota = await getUserQuota(req.authUser.id);
    return res.json({
      quota,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch user quota.', message: error?.message || error });
  }
});

router.post('/purchase', requireAuth, async (req, res) => {
  try {
    const planId = String(req.body?.planId || '').trim();
    const planCode = String(req.body?.planCode || '').trim();
    const paymentMethod = String(req.body?.paymentMethod || 'manual').trim() || 'manual';
    const notes = String(req.body?.notes || '').trim();

    if (!planId && !planCode) {
      return res.status(400).json({ error: 'planId or planCode is required.' });
    }

    const result = await purchasePlanCredits({
      userId: req.authUser.id,
      planId: planId || undefined,
      planCode: planCode || undefined,
    });

    const user = await User.findById(req.authUser.id).select('name email').lean();
    const transactionId = `TXN-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const payment = await PlanPayment.create({
      userId: req.authUser.id,
      userName: String(user?.name || 'User'),
      userEmail: String(user?.email || ''),
      planId: result.purchasedPlan.id,
      planCode: result.purchasedPlan.code,
      planName: result.purchasedPlan.name,
      amount: Number(result.purchasedPlan.price || 0),
      currency: String(result.purchasedPlan.currency || 'INR'),
      examCreditsAdded: Number(result.purchasedPlan.examCredits || 0),
      paymentStatus: 'success',
      paymentMethod,
      transactionId,
      notes,
    });

    return res.json({
      message: 'Plan activated and exam credits added successfully.',
      purchasedPlan: result.purchasedPlan,
      quota: result.quota,
      payment: {
        id: String(payment._id),
        transactionId: payment.transactionId,
        amount: Number(payment.amount || 0),
        currency: String(payment.currency || 'INR'),
        paymentStatus: payment.paymentStatus,
        paymentMethod: payment.paymentMethod,
        createdAt: payment.createdAt,
      },
    });
  } catch (error) {
    if (error?.code === 'plan_not_found') {
      return res.status(404).json({ error: 'Selected plan not found or inactive.' });
    }

    return res.status(500).json({ error: 'Failed to purchase plan.', message: error?.message || error });
  }
});

router.post('/payment/create-order', requireAuth, async (req, res) => {
  try {
    const planId = String(req.body?.planId || '').trim();
    if (!planId || !mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ error: 'Valid planId is required.' });
    }

    const plan = await Plan.findOne({ _id: planId, isActive: true }).lean();
    if (!plan?._id) {
      return res.status(404).json({ error: 'Selected plan not found or inactive.' });
    }

    const amountRupees = Number(plan.price || 0);
    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      return res.status(400).json({ error: 'Invalid plan amount.' });
    }

    const amountPaise = Math.round(amountRupees * 100);
    const orderId = `PP${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const user = await User.findById(req.authUser.id).select('name email').lean();

    await PlanPayment.create({
      userId: req.authUser.id,
      userName: String(user?.name || 'User'),
      userEmail: String(user?.email || ''),
      planId: String(plan._id),
      planCode: String(plan.code || ''),
      planName: String(plan.name || ''),
      amount: amountRupees,
      currency: String(plan.currency || 'INR'),
      examCreditsAdded: Number(plan.examCredits || 0),
      paymentStatus: 'pending',
      paymentMethod: 'phonepe',
      transactionId: orderId,
      notes: 'pending_phonepe_checkout',
    });

    const paymentOrder = await phonePeCreatePayment({
      orderId,
      amountPaise,
      planId: String(plan._id),
    });

    return res.json({
      gateway: 'phonepe',
      orderId,
      paymentUrl: paymentOrder.paymentUrl,
      plan: {
        id: String(plan._id),
        code: String(plan.code || ''),
        name: String(plan.name || ''),
        price: Number(plan.price || 0),
        examCredits: Number(plan.examCredits || 0),
        currency: String(plan.currency || 'INR'),
      },
    });
  } catch (error) {
    if (error?.code === 'phonepe_not_configured') {
      return res.status(503).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to create PhonePe order.',
      message: error?.message || error,
    });
  }
});

router.post('/payment/verify', requireAuth, async (req, res) => {
  try {
    const planId = String(req.body?.planId || '').trim();
    const orderId = String(req.body?.orderId || '').trim();

    if (!planId || !mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ error: 'Valid planId is required.' });
    }
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const existingPayment = await PlanPayment.findOne({
      userId: req.authUser.id,
      transactionId: orderId,
    });

    if (!existingPayment?._id) {
      return res.status(404).json({ error: 'Payment transaction not found.' });
    }
    if (String(existingPayment.planId) !== planId) {
      return res.status(400).json({ error: 'Plan mismatch for this transaction.' });
    }
    if (existingPayment.paymentStatus === 'success') {
      const quota = await getUserQuota(req.authUser.id);
      return res.json({
        message: 'Payment was already processed.',
        duplicate: true,
        quota,
      });
    }

    const statusResult = await phonePeCheckStatus(orderId);
    const state = String(
      statusResult?.state || statusResult?.data?.state || statusResult?.paymentDetails?.[0]?.state || ''
    ).toUpperCase();

    if (state !== 'COMPLETED') {
      existingPayment.paymentStatus = state === 'FAILED' ? 'failed' : 'pending';
      existingPayment.notes = `phonepe_status:${state || 'PENDING'}`;
      await existingPayment.save();
      return res.status(400).json({ error: `Payment not successful. Status: ${state || 'PENDING'}` });
    }

    const result = await purchasePlanCredits({
      userId: req.authUser.id,
      planId,
    });

    existingPayment.paymentStatus = 'success';
    existingPayment.notes = `phonepe_status:${state}`;
    await existingPayment.save();

    return res.json({
      message: 'Payment verified and plan activated successfully.',
      purchasedPlan: result.purchasedPlan,
      quota: result.quota,
      payment: {
        id: String(existingPayment._id),
        transactionId: existingPayment.transactionId,
        amount: Number(existingPayment.amount || 0),
        currency: String(existingPayment.currency || 'INR'),
        paymentStatus: existingPayment.paymentStatus,
        paymentMethod: existingPayment.paymentMethod,
        createdAt: existingPayment.createdAt,
      },
    });
  } catch (error) {
    if (error?.code === 'plan_not_found') {
      return res.status(404).json({ error: 'Selected plan not found or inactive.' });
    }

    return res.status(500).json({ error: 'Failed to verify payment.', message: error?.message || error });
  }
});

router.get('/payment/status/:orderId', requireAuth, async (req, res) => {
  try {
    const orderId = String(req.params?.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const data = await phonePeCheckStatus(orderId);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch payment status.', message: error?.message || error });
  }
});

module.exports = router;
