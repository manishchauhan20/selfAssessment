const User = require('../models/User');
const Plan = require('../models/Plan');

const DEFAULT_FREE_EXAM_LIMIT = Math.max(Number(process.env.DEFAULT_FREE_EXAM_LIMIT || 5) || 5  , 0);

const DEFAULT_PLANS = [
  { code: 'STARTER_19', name: 'Starter', price: 19, examCredits: 5, sortOrder: 10 },
  { code: 'GROWTH_49', name: 'Growth', price: 49, examCredits: 15, sortOrder: 20 },
  { code: 'PRO_99', name: 'Pro', price: 99, examCredits: 30, sortOrder: 30 },
];

function toInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(Math.floor(num), 0);
}

function buildQuotaSnapshot(userDoc) {
  const freeExamLimit = toInt(userDoc?.freeExamLimit, DEFAULT_FREE_EXAM_LIMIT);
  const bonusExamCredits = toInt(userDoc?.bonusExamCredits, 0);
  const usedExamCredits = toInt(userDoc?.usedExamCredits, 0);
  const totalExamCredits = freeExamLimit + bonusExamCredits;
  const remainingExamCredits = Math.max(totalExamCredits - usedExamCredits, 0);
  const lifetimeExamCreditsPurchased = toInt(userDoc?.lifetimeExamCreditsPurchased, bonusExamCredits);

  return {
    freeExamLimit,
    bonusExamCredits,
    usedExamCredits,
    totalExamCredits,
    remainingExamCredits,
    lifetimeExamCreditsPurchased,
    requiresPlanPurchase: remainingExamCredits <= 0,
  };
}

async function ensureDefaultPlans() {
  const existing = await Plan.countDocuments({});
  if (existing > 0) return;

  await Plan.insertMany(
    DEFAULT_PLANS.map((plan) => ({
      ...plan,
      currency: 'INR',
      isActive: true,
    }))
  );
}

async function getAvailablePlans() {
  await ensureDefaultPlans();
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, price: 1 }).lean();
  return plans.map((plan) => ({
    id: String(plan._id),
    code: String(plan.code || '').trim(),
    name: String(plan.name || '').trim(),
    price: Number(plan.price || 0),
    examCredits: Number(plan.examCredits || 0),
    currency: String(plan.currency || 'INR'),
    isActive: Boolean(plan.isActive),
    sortOrder: Number(plan.sortOrder || 0),
  }));
}

async function getUserQuota(userId) {
  const user = await User.findById(userId)
    .select('freeExamLimit bonusExamCredits usedExamCredits lifetimeExamCreditsPurchased')
    .lean();

  return buildQuotaSnapshot(user);
}

async function consumeOneExamCredit(userId) {
  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gt: [
          {
            $add: [
              { $ifNull: ['$freeExamLimit', DEFAULT_FREE_EXAM_LIMIT] },
              { $ifNull: ['$bonusExamCredits', 0] },
            ],
          },
          { $ifNull: ['$usedExamCredits', 0] },
        ],
      },
    },
    {
      $inc: { usedExamCredits: 1 },
      $set: { freeExamLimit: DEFAULT_FREE_EXAM_LIMIT },
    },
    {
      new: true,
      projection: {
        freeExamLimit: 1,
        bonusExamCredits: 1,
        usedExamCredits: 1,
        lifetimeExamCreditsPurchased: 1,
      },
    }
  ).lean();

  if (!updated?._id) {
    const quota = await getUserQuota(userId);
    return { ok: false, quota };
  }

  return { ok: true, quota: buildQuotaSnapshot(updated) };
}

async function purchasePlanCredits({ userId, planId, planCode }) {
  await ensureDefaultPlans();

  let plan = null;
  if (planId) {
    plan = await Plan.findOne({ _id: planId, isActive: true }).lean();
  } else if (planCode) {
    plan = await Plan.findOne({ code: String(planCode).trim(), isActive: true }).lean();
  }

  if (!plan?._id) {
    const error = new Error('Plan not found.');
    error.code = 'plan_not_found';
    throw error;
  }

  const credits = toInt(plan.examCredits, 0);
  if (credits <= 0) {
    const error = new Error('Invalid plan exam credit value.');
    error.code = 'invalid_plan';
    throw error;
  }

  const updated = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        bonusExamCredits: credits,
        lifetimeExamCreditsPurchased: credits,
      },
      $set: { freeExamLimit: DEFAULT_FREE_EXAM_LIMIT },
    },
    {
      new: true,
      projection: {
        freeExamLimit: 1,
        bonusExamCredits: 1,
        usedExamCredits: 1,
        lifetimeExamCreditsPurchased: 1,
      },
    }
  ).lean();

  if (!updated?._id) {
    const error = new Error('User not found.');
    error.code = 'user_not_found';
    throw error;
  }

  return {
    purchasedPlan: {
      id: String(plan._id),
      code: String(plan.code || ''),
      name: String(plan.name || ''),
      price: Number(plan.price || 0),
      examCredits: credits,
      currency: String(plan.currency || 'INR'),
    },
    quota: buildQuotaSnapshot(updated),
  };
}

module.exports = {
  DEFAULT_FREE_EXAM_LIMIT,
  buildQuotaSnapshot,
  ensureDefaultPlans,
  getAvailablePlans,
  getUserQuota,
  consumeOneExamCredit,
  purchasePlanCredits,
};
