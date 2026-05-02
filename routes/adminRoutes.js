const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');

const AdminCredential = require('../models/AdminCredential');
const User = require('../models/User');
const ExamAttempt = require('../models/ExamAttempt');
const Plan = require('../models/Plan');
const PlanPayment = require('../models/PlanPayment');
const Book = require('../models/Book');
const TeacherStudent = require('../models/TeacherStudent');
const { extractTextFromPDF } = require('../utils/pdfProcessor');
const { parsePdfTextToStructuredData, validateParsedPDFData, getValidChapters, getValidTopics } = require('../utils/pdfArchitecture');
const { DEFAULT_FREE_EXAM_LIMIT, ensureDefaultPlans, buildQuotaSnapshot } = require('../utils/quotaManager');

const router = express.Router();

const DEFAULT_ADMIN_EMAIL = (process.env.ADMIN_DEFAULT_EMAIL || 'cm80818087@gmail.com')
  .trim()
  .toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || '123456';
const JWT_SECRET = process.env.JWT_SECRET || 'mySecretKey';
const BOOK_UPLOAD_MAX_FILE_SIZE_MB = Math.max(5, Number(process.env.BOOK_UPLOAD_MAX_FILE_SIZE_MB) || 200);
const BOOK_UPLOAD_MAX_FILES = Math.max(1, Number(process.env.BOOK_UPLOAD_MAX_FILES) || 10);
const upload = multer({
  storage: multer.memoryStorage(),  
  limits: { fileSize: BOOK_UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024, files: BOOK_UPLOAD_MAX_FILES },
});

async function ensureDefaultAdminCredential() {
  const existing = await AdminCredential.findOne({ email: DEFAULT_ADMIN_EMAIL }).lean();
  if (existing?._id) return existing;

  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  const created = await AdminCredential.create({
    email: DEFAULT_ADMIN_EMAIL,
    passwordHash,
  });
  return created.toObject();
}

function getAdminFromRequest(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded?.role !== 'admin') return null;
    return { adminId: String(decoded?.adminId || ''), email: String(decoded?.email || '') };
  } catch {
    return null;
  }
}

async function requireAdmin(req, res, next) {
  const admin = getAdminFromRequest(req);
  if (!admin?.adminId) {
    return res.status(401).json({ message: 'Unauthorized admin access.' });
  }
  req.admin = admin;
  return next();
}

function summarizeParsedBook(parsedData) {
  const chapters = getValidChapters(parsedData);
  let topicCount = 0;
  let questionCount = 0;

  for (const chapterName of chapters) {
    const topics = getValidTopics(parsedData, chapterName);
    topicCount += topics.length;
    for (const topicName of topics) {
      const topicNode = parsedData?.[chapterName]?.topics?.[topicName];
      const questions = Array.isArray(topicNode?.questions) ? topicNode.questions : [];
      questionCount += questions.length;
    }
  }

  return {
    chapterCount: chapters.length,
    topicCount,
    questionCount,
    chapters: chapters.map((chapterName) => ({
      name: chapterName,
      topics: getValidTopics(parsedData, chapterName),
    })),
  };
}

router.post('/login', async (req, res) => {
  try {
    await ensureDefaultAdminCredential();

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const adminCredential = await AdminCredential.findOne({ email });
    if (!adminCredential) {
      return res.status(400).json({ message: 'Invalid admin email.' });
    }

    const isValidPassword = await bcrypt.compare(password, adminCredential.passwordHash);
    if (!isValidPassword) {
      return res.status(400).json({ message: 'Invalid admin password.' });
    }

    const token = jwt.sign(
      { adminId: String(adminCredential._id), role: 'admin', email: adminCredential.email },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    return res.json({
      message: 'Admin login successful.',
      token,
      email: adminCredential.email,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Admin login failed.', error: error?.message || error });
  }
});

router.get('/profile', requireAdmin, async (req, res) => {
  try {
    const adminCredential = await AdminCredential.findById(req.admin.adminId).lean();
    if (!adminCredential?._id) {
      return res.status(404).json({ message: 'Admin profile not found.' });
    }
    return res.json({ email: adminCredential.email });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch admin profile.', error: error?.message || error });
  }
});

router.patch('/profile', requireAdmin, async (req, res) => {
  try {
    const nextEmail = String(req.body?.email || '').trim().toLowerCase();
    const nextPassword = String(req.body?.password || '').trim();

    const update = {};
    if (nextEmail) {
      const existing = await AdminCredential.findOne({ email: nextEmail }).lean();
      if (existing?._id && String(existing._id) !== String(req.admin.adminId)) {
        return res.status(400).json({ message: 'Email already in use.' });
      }
      update.email = nextEmail;
    }

    if (nextPassword) {
      if (nextPassword.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
      }
      update.passwordHash = await bcrypt.hash(nextPassword, 10);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'Nothing to update.' });
    }

    const updated = await AdminCredential.findByIdAndUpdate(req.admin.adminId, { $set: update }, { new: true }).lean();
    if (!updated?._id) {
      return res.status(404).json({ message: 'Admin profile not found.' });
    }

    return res.json({ message: 'Admin profile updated.', email: updated.email });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update admin profile.', error: error?.message || error });
  }
});

router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    await ensureDefaultPlans();
    const userLimit = Math.min(Math.max(Number(req.query.userLimit) || 200, 1), 1000);
    const attemptLimit = Math.min(Math.max(Number(req.query.attemptLimit) || 300, 1), 2000);
    const leaderboardLimit = Math.min(Math.max(Number(req.query.leaderboardLimit) || 100, 1), 500);
    const paymentLimit = Math.min(Math.max(Number(req.query.paymentLimit) || 500, 1), 2000);

    const [totalUsers, totalAttempts, completedAttempts, avgAgg, users, teacherStudents, attempts, payments, paymentAgg, books] = await Promise.all([
      User.countDocuments({}),
      ExamAttempt.countDocuments({}),
      ExamAttempt.countDocuments({ score: { $ne: null } }),
      ExamAttempt.aggregate([
        { $match: { score: { $ne: null } } },
        { $group: { _id: null, avgScore: { $avg: '$score' } } },
      ]),
      User.find({})
        .sort({ createdAt: -1 })
        .limit(userLimit)
        .select('name email role class createdAt loginCount freeExamLimit bonusExamCredits usedExamCredits lifetimeExamCreditsPurchased')
        .lean(),
      TeacherStudent.find({})
        .sort({ createdAt: -1 })
        .limit(userLimit)
        .select('studentName studentEmail className teacherName teacherEmail teacherRole createdAt updatedAt')
        .lean(),
      ExamAttempt.find({})
        .sort({ createdAt: -1 })
        .limit(attemptLimit)
        .populate('userId', 'name email role')
        .lean(),
      PlanPayment.find({})
        .sort({ createdAt: -1 })
        .limit(paymentLimit)
        .lean(),
      PlanPayment.aggregate([
        { $match: { paymentStatus: 'success' } },
        { $group: { _id: null, totalRevenue: { $sum: '$amount' }, totalPayments: { $sum: 1 } } },
      ]),
      Book.find({})
        .sort({ createdAt: -1 })
        .select('title className subject sourceFileName chapterCount topicCount questionCount createdAt')
        .lean(),
    ]);

    const leaderboard = await ExamAttempt.aggregate([
      { $match: { score: { $ne: null }, userId: { $ne: null } } },
      {
        $group: {
          _id: '$userId',
          avgScore: { $avg: '$score' },
          bestScore: { $max: '$score' },
          attempts: { $sum: 1 },
        },
      },
      { $sort: { avgScore: -1, bestScore: -1, attempts: -1 } },
      { $limit: leaderboardLimit },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          userId: { $toString: '$_id' },
          name: '$user.name',
          email: '$user.email',
          avgScore: { $round: ['$avgScore', 2] },
          bestScore: 1,
          attempts: 1,
        },
      },
    ]);

    const plans = await Plan.find({}).sort({ sortOrder: 1, price: 1 }).lean();

    const mergedUsers = users.map((user) => ({
      ...user,
      sourceType: 'user',
      quota: buildQuotaSnapshot(user),
    }));
    const emailToIndex = new Map(
      mergedUsers.map((user, index) => [String(user.email || '').trim().toLowerCase(), index])
    );

    teacherStudents.forEach((student) => {
      const studentEmail = String(student.studentEmail || '').trim().toLowerCase();
      const existingIndex = emailToIndex.get(studentEmail);
      if (existingIndex !== undefined) {
        mergedUsers[existingIndex] = {
          ...mergedUsers[existingIndex],
          teacherName: String(student.teacherName || ''),
          teacherEmail: String(student.teacherEmail || ''),
          teacherRole: String(student.teacherRole || ''),
          teacherStudentId: String(student._id || ''),
          managedByTeacher: true,
        };
        return;
      }

      mergedUsers.push({
        _id: String(student._id),
        name: String(student.studentName || ''),
        email: studentEmail,
        role: 'teacher_student',
        class: String(student.className || ''),
        loginCount: 0,
        freeExamLimit: 0,
        bonusExamCredits: 0,
        usedExamCredits: 0,
        createdAt: student.createdAt,
        sourceType: 'teacher_student',
        teacherName: String(student.teacherName || ''),
        teacherEmail: String(student.teacherEmail || ''),
        teacherRole: String(student.teacherRole || ''),
        teacherStudentId: String(student._id || ''),
        managedByTeacher: true,
      });
    });

    return res.json({
      stats: {
        totalUsers,
        totalAttempts,
        completedAttempts,
        averageScore: Math.round(Number(avgAgg?.[0]?.avgScore || 0)),
        totalPayments: Number(paymentAgg?.[0]?.totalPayments || 0),
        totalRevenue: Number(paymentAgg?.[0]?.totalRevenue || 0),
        totalBooks: Number(books.length || 0),
      },
      users: mergedUsers.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      attempts: attempts.map((attempt) => ({
        id: String(attempt._id),
        user: attempt.userId
          ? {
              id: String(attempt.userId._id || ''),
              name: attempt.userId.name || 'User',
              email: attempt.userId.email || '',
              role: attempt.userId.role || '',
            }
          : null,
        source: attempt.source || 'ncert',
        chapter: attempt.chapter || '',
        topic: attempt.topic || '',
        difficulty: attempt.difficulty || 'Medium',
        score: attempt.score == null ? null : Number(attempt.score),
        correct: attempt.correct == null ? null : Number(attempt.correct),
        wrong: attempt.wrong == null ? null : Number(attempt.wrong),
        totalQuestions: attempt.totalQuestions == null ? null : Number(attempt.totalQuestions),
        createdAt: attempt.createdAt,
      })),
      leaderboard: leaderboard.map((row, index) => ({
        rank: index + 1,
        userId: row.userId,
        name: row.name || 'User',
        email: row.email || '',
        avgScore: Number(row.avgScore || 0),
        bestScore: Number(row.bestScore || 0),
        attempts: Number(row.attempts || 0),
      })),
      plans: plans.map((plan) => ({
        id: String(plan._id),
        code: String(plan.code || ''),
        name: String(plan.name || ''),
        price: Number(plan.price || 0),
        examCredits: Number(plan.examCredits || 0),
        currency: String(plan.currency || 'INR'),
        isActive: Boolean(plan.isActive),
        sortOrder: Number(plan.sortOrder || 0),
      })),
      defaults: {
        freeExamLimit: DEFAULT_FREE_EXAM_LIMIT,
      },
      payments: payments.map((payment) => ({
        id: String(payment._id),
        transactionId: String(payment.transactionId || ''),
        userId: String(payment.userId || ''),
        userName: String(payment.userName || 'User'),
        userEmail: String(payment.userEmail || ''),
        planId: String(payment.planId || ''),
        planCode: String(payment.planCode || ''),
        planName: String(payment.planName || ''),
        amount: Number(payment.amount || 0),
        currency: String(payment.currency || 'INR'),
        examCreditsAdded: Number(payment.examCreditsAdded || 0),
        paymentStatus: String(payment.paymentStatus || 'success'),
        paymentMethod: String(payment.paymentMethod || 'manual'),
        notes: String(payment.notes || ''),
        createdAt: payment.createdAt,
      })),
      books: books.map((book) => ({
        id: String(book._id),
        title: String(book.title || ''),
        className: String(book.className || ''),
        subject: String(book.subject || ''),
        sourceFileName: String(book.sourceFileName || ''),
        chapterCount: Number(book.chapterCount || 0),
        topicCount: Number(book.topicCount || 0),
        questionCount: Number(book.questionCount || 0),
        createdAt: book.createdAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch admin dashboard.', error: error?.message || error });
  }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const role = String(req.body?.role || '').trim();
    const className = String(req.body?.class || '').trim();
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const freeExamLimitRaw = req.body?.freeExamLimit;
    const bonusExamCreditsRaw = req.body?.bonusExamCredits;
    const usedExamCreditsRaw = req.body?.usedExamCredits;

    const update = {};
    if (name) update.name = name;
    if (email) {
      const exists = await User.findOne({ email, _id: { $ne: userId } }).lean();
      if (exists?._id) {
        return res.status(400).json({ message: 'Email already in use by another user.' });
      }
      update.email = email;
    }
    if (role) {
      if (!['student', 'individual_tutor', 'coaching_institute'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role.' });
      }
      update.role = role;
    }
    update.class = className;

    if (freeExamLimitRaw !== undefined) {
      const value = Number(freeExamLimitRaw);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: 'Invalid freeExamLimit.' });
      }
      update.freeExamLimit = Math.floor(value);
    }

    if (bonusExamCreditsRaw !== undefined) {
      const value = Number(bonusExamCreditsRaw);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: 'Invalid bonusExamCredits.' });
      }
      update.bonusExamCredits = Math.floor(value);
    }

    if (usedExamCreditsRaw !== undefined) {
      const value = Number(usedExamCreditsRaw);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: 'Invalid usedExamCredits.' });
      }
      update.usedExamCredits = Math.floor(value);
    }

    const updated = await User.findByIdAndUpdate(userId, { $set: update }, { new: true })
      .select('name email role class createdAt loginCount freeExamLimit bonusExamCredits usedExamCredits lifetimeExamCreditsPurchased')
      .lean();

    if (!updated?._id) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({
      message: 'User updated successfully.',
      user: {
        ...updated,
        quota: buildQuotaSnapshot(updated),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update user.', error: error?.message || error });
  }
});

router.patch('/teacher-students/:id', requireAdmin, async (req, res) => {
  try {
    const studentId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: 'Invalid teacher student id.' });
    }

    const studentName = String(req.body?.name || '').trim();
    const studentEmail = String(req.body?.email || '').trim().toLowerCase();
    const className = String(req.body?.class || '').trim();

    if (!studentName || !studentEmail) {
      return res.status(400).json({ message: 'Name and email are required.' });
    }

    const updated = await TeacherStudent.findByIdAndUpdate(
      studentId,
      {
        $set: {
          studentName,
          studentEmail,
          className,
        },
      },
      { new: true, runValidators: true }
    ).lean();

    if (!updated?._id) {
      return res.status(404).json({ message: 'Teacher student not found.' });
    }

    return res.json({
      message: 'Teacher student updated successfully.',
      user: {
        _id: String(updated._id),
        name: String(updated.studentName || ''),
        email: String(updated.studentEmail || ''),
        role: 'teacher_student',
        class: String(updated.className || ''),
        createdAt: updated.createdAt,
        sourceType: 'teacher_student',
        teacherName: String(updated.teacherName || ''),
        teacherEmail: String(updated.teacherEmail || ''),
        teacherRole: String(updated.teacherRole || ''),
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'This student email is already assigned to that teacher.' });
    }
    return res.status(500).json({ message: 'Failed to update teacher student.', error: error?.message || error });
  }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const deletedUser = await User.findByIdAndDelete(userId).lean();
    if (!deletedUser?._id) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const attemptDeleteResult = await ExamAttempt.deleteMany({ userId });
    await PlanPayment.deleteMany({ userId });

    return res.json({
      message: 'User and associated exam attempts deleted.',
      deletedAttempts: Number(attemptDeleteResult?.deletedCount || 0),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete user.', error: error?.message || error });
  }
});

router.delete('/teacher-students/:id', requireAdmin, async (req, res) => {
  try {
    const studentId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: 'Invalid teacher student id.' });
    }

    const deleted = await TeacherStudent.findByIdAndDelete(studentId).lean();
    if (!deleted?._id) {
      return res.status(404).json({ message: 'Teacher student not found.' });
    }

    return res.json({ message: 'Teacher student deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete teacher student.', error: error?.message || error });
  }
});

router.patch('/attempts/:id', requireAdmin, async (req, res) => {
  try {
    const attemptId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(attemptId)) {
      return res.status(400).json({ message: 'Invalid attempt id.' });
    }

    const update = {
      source: String(req.body?.source || '').trim() || undefined,
      className: String(req.body?.className || '').trim(),
      subject: String(req.body?.subject || '').trim(),
      chapter: String(req.body?.chapter || '').trim(),
      topic: String(req.body?.topic || '').trim(),
      difficulty: String(req.body?.difficulty || '').trim() || undefined,
      score: req.body?.score === '' || req.body?.score == null ? null : Number(req.body.score),
      correct: req.body?.correct === '' || req.body?.correct == null ? null : Number(req.body.correct),
      wrong: req.body?.wrong === '' || req.body?.wrong == null ? null : Number(req.body.wrong),
      totalQuestions:
        req.body?.totalQuestions === '' || req.body?.totalQuestions == null ? null : Number(req.body.totalQuestions),
    };

    const cleanUpdate = {};
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      if (typeof value === 'number' && Number.isNaN(value)) {
        return res.status(400).json({ message: `Invalid numeric value for ${key}.` });
      }
      cleanUpdate[key] = value;
    }

    if (cleanUpdate.source && !['ncert', 'other'].includes(cleanUpdate.source)) {
      return res.status(400).json({ message: 'Invalid source.' });
    }

    const updated = await ExamAttempt.findByIdAndUpdate(attemptId, { $set: cleanUpdate }, { new: true })
      .populate('userId', 'name email role')
      .lean();

    if (!updated?._id) {
      return res.status(404).json({ message: 'Attempt not found.' });
    }

    return res.json({
      message: 'Attempt updated successfully.',
      attempt: {
        id: String(updated._id),
        user: updated.userId
          ? {
              id: String(updated.userId._id || ''),
              name: updated.userId.name || 'User',
              email: updated.userId.email || '',
              role: updated.userId.role || '',
            }
          : null,
        source: updated.source || 'ncert',
        className: updated.className || '',
        subject: updated.subject || '',
        chapter: updated.chapter || '',
        topic: updated.topic || '',
        difficulty: updated.difficulty || 'Medium',
        score: updated.score == null ? null : Number(updated.score),
        correct: updated.correct == null ? null : Number(updated.correct),
        wrong: updated.wrong == null ? null : Number(updated.wrong),
        totalQuestions: updated.totalQuestions == null ? null : Number(updated.totalQuestions),
        createdAt: updated.createdAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update attempt.', error: error?.message || error });
  }
});

router.delete('/attempts/:id', requireAdmin, async (req, res) => {
  try {
    const attemptId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(attemptId)) {
      return res.status(400).json({ message: 'Invalid attempt id.' });
    }

    const deleted = await ExamAttempt.findByIdAndDelete(attemptId).lean();
    if (!deleted?._id) {
      return res.status(404).json({ message: 'Attempt not found.' });
    }

    return res.json({ message: 'Attempt deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete attempt.', error: error?.message || error });
  }
});

router.get('/plans', requireAdmin, async (req, res) => {
  try {
    await ensureDefaultPlans();
    const plans = await Plan.find({}).sort({ sortOrder: 1, price: 1 }).lean();
    return res.json({
      defaults: { freeExamLimit: DEFAULT_FREE_EXAM_LIMIT },
      plans: plans.map((plan) => ({
        id: String(plan._id),
        code: String(plan.code || ''),
        name: String(plan.name || ''),
        price: Number(plan.price || 0),
        examCredits: Number(plan.examCredits || 0),
        currency: String(plan.currency || 'INR'),
        isActive: Boolean(plan.isActive),
        sortOrder: Number(plan.sortOrder || 0),
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch plans.', error: error?.message || error });
  }
});

router.post('/plans', requireAdmin, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    const name = String(req.body?.name || '').trim();
    const price = Number(req.body?.price);
    const examCredits = Number(req.body?.examCredits);
    const currency = String(req.body?.currency || 'INR').trim() || 'INR';
    const sortOrder = Number(req.body?.sortOrder ?? 0);

    if (!code || !name) {
      return res.status(400).json({ message: 'code and name are required.' });
    }
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ message: 'Invalid price.' });
    }
    if (!Number.isFinite(examCredits) || examCredits <= 0) {
      return res.status(400).json({ message: 'Invalid examCredits.' });
    }

    const created = await Plan.create({
      code,
      name,
      price: Math.floor(price),
      examCredits: Math.floor(examCredits),
      currency,
      isActive: Boolean(req.body?.isActive ?? true),
      sortOrder: Number.isFinite(sortOrder) ? Math.floor(sortOrder) : 0,
    });

    return res.status(201).json({
      message: 'Plan created successfully.',
      plan: {
        id: String(created._id),
        code: created.code,
        name: created.name,
        price: Number(created.price || 0),
        examCredits: Number(created.examCredits || 0),
        currency: created.currency || 'INR',
        isActive: Boolean(created.isActive),
        sortOrder: Number(created.sortOrder || 0),
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'Plan code already exists.' });
    }
    return res.status(500).json({ message: 'Failed to create plan.', error: error?.message || error });
  }
});

router.patch('/plans/:id', requireAdmin, async (req, res) => {
  try {
    const planId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ message: 'Invalid plan id.' });
    }

    const update = {};
    if (req.body?.code !== undefined) {
      const code = String(req.body.code || '').trim();
      if (!code) return res.status(400).json({ message: 'Invalid code.' });
      update.code = code;
    }
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ message: 'Invalid name.' });
      update.name = name;
    }
    if (req.body?.price !== undefined) {
      const value = Number(req.body.price);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: 'Invalid price.' });
      }
      update.price = Math.floor(value);
    }
    if (req.body?.examCredits !== undefined) {
      const value = Number(req.body.examCredits);
      if (!Number.isFinite(value) || value <= 0) {
        return res.status(400).json({ message: 'Invalid examCredits.' });
      }
      update.examCredits = Math.floor(value);
    }
    if (req.body?.sortOrder !== undefined) {
      const value = Number(req.body.sortOrder);
      if (!Number.isFinite(value)) {
        return res.status(400).json({ message: 'Invalid sortOrder.' });
      }
      update.sortOrder = Math.floor(value);
    }
    if (req.body?.currency !== undefined) {
      const value = String(req.body.currency || '').trim() || 'INR';
      update.currency = value;
    }
    if (req.body?.isActive !== undefined) {
      update.isActive = Boolean(req.body.isActive);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'Nothing to update.' });
    }

    const updated = await Plan.findByIdAndUpdate(planId, { $set: update }, { new: true }).lean();
    if (!updated?._id) {
      return res.status(404).json({ message: 'Plan not found.' });
    }

    return res.json({
      message: 'Plan updated successfully.',
      plan: {
        id: String(updated._id),
        code: String(updated.code || ''),
        name: String(updated.name || ''),
        price: Number(updated.price || 0),
        examCredits: Number(updated.examCredits || 0),
        currency: String(updated.currency || 'INR'),
        isActive: Boolean(updated.isActive),
        sortOrder: Number(updated.sortOrder || 0),
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'Plan code already exists.' });
    }
    return res.status(500).json({ message: 'Failed to update plan.', error: error?.message || error });
  }
});

router.get('/books', requireAdmin, async (req, res) => {
  try {
    const books = await Book.find({})
      .sort({ createdAt: -1 })
      .select('title className subject sourceFileName chapterCount topicCount questionCount createdAt')
      .lean();

    return res.json({
      books: books.map((book) => ({
        id: String(book._id),
        title: String(book.title || ''),
        className: String(book.className || ''),
        subject: String(book.subject || ''),
        sourceFileName: String(book.sourceFileName || ''),
        chapterCount: Number(book.chapterCount || 0),
        topicCount: Number(book.topicCount || 0),
        questionCount: Number(book.questionCount || 0),
        createdAt: book.createdAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch books.', error: error?.message || error });
  }
});

router.post('/books/upload', requireAdmin, upload.array('books', BOOK_UPLOAD_MAX_FILES), async (req, res) => {
  try {
    const className = String(req.body?.className || '').trim();
    const subject = String(req.body?.subject || '').trim();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!className || !subject) {
      return res.status(400).json({ message: 'className and subject are required.' });
    }
    if (files.length === 0) {
      return res.status(400).json({ message: 'At least one PDF file is required.' });
    }

    const uploaded = [];
    const skipped = [];

    for (const file of files) {
      try {
        const text = await extractTextFromPDF(file.buffer);
        const parsedData = validateParsedPDFData(parsePdfTextToStructuredData(text));
        const summary = summarizeParsedBook(parsedData);

        if (summary.chapterCount <= 0 || summary.topicCount <= 0) {
          skipped.push({
            fileName: String(file.originalname || ''),
            reason: 'No valid chapter/topic structure found in this PDF.',
          });
          continue;
        }

        const cleanName = String(file.originalname || '').replace(/\.pdf$/i, '').trim();
        const title = cleanName || `Book ${Date.now()}`;

        const created = await Book.create({
          title,
          className,
          subject,
          sourceFileName: String(file.originalname || ''),
          parsedData,
          chapterCount: summary.chapterCount,
          topicCount: summary.topicCount,
          questionCount: summary.questionCount,
          createdByAdminId: req.admin.adminId,
        });

        uploaded.push({
          id: String(created._id),
          title,
          className,
          subject,
          sourceFileName: String(file.originalname || ''),
          chapterCount: summary.chapterCount,
          topicCount: summary.topicCount,
          questionCount: summary.questionCount,
          createdAt: created.createdAt,
        });
      } catch (error) {
        skipped.push({
          fileName: String(file.originalname || ''),
          reason: error?.message || 'Failed to parse PDF.',
        });
      }
    }

    return res.status(201).json({
      message: uploaded.length > 0 ? 'Books uploaded successfully.' : 'No book could be uploaded.',
      limits: {
        maxFileSizeMB: BOOK_UPLOAD_MAX_FILE_SIZE_MB,
        maxFiles: BOOK_UPLOAD_MAX_FILES,
      },
      uploaded,
      skipped,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to upload books.', error: error?.message || error });
  }
});

router.delete('/books/:id', requireAdmin, async (req, res) => {
  try {
    const bookId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(bookId)) {
      return res.status(400).json({ message: 'Invalid book id.' });
    }

    const deleted = await Book.findByIdAndDelete(bookId).lean();
    if (!deleted?._id) {
      return res.status(404).json({ message: 'Book not found.' });
    }

    return res.json({ message: 'Book deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to delete book.', error: error?.message || error });
  }
});

module.exports = router;
