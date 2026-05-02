const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('./env');

const { connectToDatabase, isDatabaseConnected } = require('./config/database');
const ExamAttempt = require('./models/ExamAttempt');
const User = require('./models/User');
const AssistantRecord = require('./models/AssistantRecord');
const TeacherPanelState = require('./models/TeacherPanelState');
const TeacherStudent = require('./models/TeacherStudent');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const planRoutes = require('./routes/planRoutes');
const bookRoutes = require('./routes/bookRoutes');
const { solveDoubt } = require('./utils/assistantEngine');
const {
  ensureDefaultPlans,
  getUserQuota,
  consumeOneExamCredit,
} = require('./utils/quotaManager');

const { generateQuiz } = require('./utils/aiEngine');
const { extractTextFromPDF } = require('./utils/pdfProcessor');
const {
  parsePdfTextToStructuredData,
  validateParsedPDFData,
  getValidChapters,
  getValidTopics,
  safeGenerateExam,
} = require('./utils/pdfArchitecture');

const app = express();
const PDF_UPLOAD_MAX_FILE_SIZE_MB = Math.max(15, Number(process.env.PDF_UPLOAD_MAX_FILE_SIZE_MB) || 200);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PDF_UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/books', bookRoutes);

const EMPTY_TEACHER_PANEL_DATA = {
  questionPapers: [],
  schedules: [],
  announcements: [],
  teacherExams: [],
  examSubmissions: [],
  students: [],
};

function normalizeTeacherPanelData(input = {}) {
  return {
    questionPapers: Array.isArray(input?.questionPapers) ? input.questionPapers : [],
    schedules: Array.isArray(input?.schedules) ? input.schedules : [],
    announcements: Array.isArray(input?.announcements) ? input.announcements : [],
    teacherExams: Array.isArray(input?.teacherExams) ? input.teacherExams : [],
    examSubmissions: Array.isArray(input?.examSubmissions) ? input.examSubmissions : [],
    students: Array.isArray(input?.students) ? input.students : [],
  };
}

function normalizeClassValue(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeClassScopeKey(value = '') {
  return normalizeClassValue(value)
    .replace(/standard+/g, '')
    .replace(/class+/g, '')
    .replace(/grade+/g, '')
    .replace(/std+/g, '')
    .replace(/batch+/g, '')
    .replace(/section+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isClassScopedStudent(user = {}) {
  const role = String(user?.role || '').trim().toLowerCase();
  return role === 'student';
}

function isTeacherRole(role = '') {
  const normalizedRole = String(role || '').trim().toLowerCase();
  return normalizedRole === 'individual_tutor' || normalizedRole === 'coaching_institute';
}

function shouldIncludeClassScopedItem(itemClassName = '', userClassName = '') {
  const normalizedItemClass = normalizeClassValue(itemClassName);
  if (!normalizedItemClass) return true;
  const normalizedUserClass = normalizeClassValue(userClassName);
  if (normalizedItemClass === normalizedUserClass) return true;

  const itemScopeKey = normalizeClassScopeKey(itemClassName);
  const userScopeKey = normalizeClassScopeKey(userClassName);
  return Boolean(itemScopeKey) && itemScopeKey === userScopeKey;
}

function filterTeacherPanelDataForUser(data, user, userEmail = '') {
  const normalized = normalizeTeacherPanelData(data);
  if (!user?.id) {
    return normalized;
  }

  if (isTeacherRole(user?.role || '')) {
    return normalized;
  }

  if (!isClassScopedStudent(user)) {
    return {
      ...normalized,
      questionPapers: [],
      teacherExams: [],
      schedules: [],
      announcements: [],
      examSubmissions: [],
      students: [],
    };
  }

  const userClassName = String(user?.class || '');
  return {
    ...normalized,
    questionPapers: normalized.questionPapers.filter((item) =>
      shouldIncludeClassScopedItem(item?.className, userClassName)
    ),
    schedules: normalized.schedules.filter((item) =>
      shouldIncludeClassScopedItem(item?.className, userClassName)
    ),
    announcements: normalized.announcements.filter((item) =>
      shouldIncludeClassScopedItem(item?.className, userClassName)
    ),
    teacherExams: normalized.teacherExams.filter((item) =>
      shouldIncludeClassScopedItem(item?.className, userClassName)
    ),
    examSubmissions: normalized.examSubmissions.filter(
      (item) => String(item?.studentEmail || '').trim().toLowerCase() === userEmail
    ),
    students: [],
  };
}

async function resolveTeacherPanelContext(authUser) {
  if (!authUser?.id || !isDatabaseConnected()) {
    return {
      panelKey: '',
      role: '',
      teacherUserId: '',
      teacherEmail: '',
      userEmail: '',
      className: '',
      assignmentClassName: '',
      students: [],
    };
  }

  const userProfile = await User.findById(authUser.id).select('role class email').lean();
  const role = String(userProfile?.role || authUser?.role || '').trim().toLowerCase();
  const userEmail = String(userProfile?.email || '').trim().toLowerCase();
  const className = String(userProfile?.class || '');

  if (isTeacherRole(role)) {
    const students = await TeacherStudent.find({ teacherUserId: authUser.id }).sort({ createdAt: -1 }).lean();
    return {
      panelKey: `teacher:${String(authUser.id)}`,
      role,
      teacherUserId: String(authUser.id),
      teacherEmail: userEmail,
      userEmail,
      className,
      assignmentClassName: className,
      students: students.map(mapTeacherStudent),
    };
  }

  if (role === 'student' && userEmail) {
    const assignment = await TeacherStudent.findOne({ studentEmail: userEmail }).sort({ createdAt: -1 }).lean();
    return {
      panelKey: assignment?.teacherUserId ? `teacher:${String(assignment.teacherUserId)}` : '',
      role,
      teacherUserId: String(assignment?.teacherUserId || ''),
      teacherEmail: String(assignment?.teacherEmail || '').trim().toLowerCase(),
      userEmail,
      className,
      assignmentClassName: String(assignment?.className || className || ''),
      students: [],
    };
  }

  return {
    panelKey: '',
    role,
    teacherUserId: '',
    teacherEmail: '',
    userEmail,
    className,
    assignmentClassName: className,
    students: [],
  };
}

function mapTeacherStudent(studentDoc = {}) {
  return {
    id: String(studentDoc?._id || studentDoc?.id || ''),
    studentName: String(studentDoc?.studentName || ''),
    studentEmail: String(studentDoc?.studentEmail || '').trim().toLowerCase(),
    className: String(studentDoc?.className || ''),
    phone: String(studentDoc?.phone || ''),
    notes: String(studentDoc?.notes || ''),
    createdAt: studentDoc?.createdAt || null,
    updatedAt: studentDoc?.updatedAt || null,
    teacherName: String(studentDoc?.teacherName || ''),
    teacherEmail: String(studentDoc?.teacherEmail || '').trim().toLowerCase(),
    teacherRole: String(studentDoc?.teacherRole || ''),
  };
}

function getAuthUserFromRequest(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'mySecretKey');
    return {
      id: String(decoded?.id || ''),
      role: String(decoded?.role || ''),
    };
  } catch {
    return null;
  }
}

function getProfileCompletionState(user) {
  const role = String(user?.role || '').trim().toLowerCase();
  const className = String(user?.class || '').trim();
  const hasAccountType = ["student", "individual_tutor", "coaching_institute"].includes(role);
  return {
    hasAccountType,
    needsClass: role === "student",
    hasClass: Boolean(className),
    isComplete: hasAccountType && (role !== "student" || Boolean(className)),
  };
}

async function getTeacherManagedStudentAssignment(authUser) {
  if (!authUser?.id || !isDatabaseConnected()) return null;

  const user = await User.findById(authUser.id).select('role email').lean();
  if (!user?._id) return null;

  const role = String(user.role || '').trim().toLowerCase();
  const email = String(user.email || '').trim().toLowerCase();
  if (role !== 'student' || !email) return null;

  return TeacherStudent.findOne({ studentEmail: email })
    .sort({ createdAt: -1 })
    .select('teacherUserId teacherName teacherEmail teacherRole className')
    .lean();
}

app.get('/api/teacher-panel', async (req, res) => {
  try {
    const authUser = getAuthUserFromRequest(req);
    const context = await resolveTeacherPanelContext(authUser);
    const doc = context.panelKey ? await TeacherPanelState.findOne({ key: context.panelKey }).lean() : null;

    const baseData = normalizeTeacherPanelData(doc?.data || EMPTY_TEACHER_PANEL_DATA);
    const filteredData = filterTeacherPanelDataForUser(baseData, {
      id: authUser?.id || '',
      role: context.role,
      class: context.assignmentClassName || context.className,
    }, context.userEmail);

    const data = {
      ...filteredData,
      students: context.students,
    };

    return res.json({ data });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch teacher panel data.', error: error?.message || error });
  }
});

app.put('/api/teacher-panel', async (req, res) => {
  try {
    const authUser = getAuthUserFromRequest(req);
    const context = await resolveTeacherPanelContext(authUser);
    if (!context.panelKey || !isTeacherRole(context.role)) {
      return res.status(403).json({ message: 'Only teacher accounts can save teacher panel data.' });
    }
    const data = normalizeTeacherPanelData(req.body?.data || {});
    const updated = await TeacherPanelState.findOneAndUpdate(
      { key: context.panelKey },
      { $set: { data } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      message: 'Teacher panel data synced.',
      data: normalizeTeacherPanelData(updated?.data || data),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to save teacher panel data.', error: error?.message || error });
  }
});

app.post('/api/teacher-panel/students', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ message: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ message: 'Unauthorized. Please login again.' });
    }

    const teacher = await User.findById(authUser.id).select('name email role').lean();
    if (!teacher?._id || !isTeacherRole(teacher.role)) {
      return res.status(403).json({ message: 'Only teacher accounts can add students.' });
    }

    const studentName = String(req.body?.studentName || '').trim();
    const studentEmail = String(req.body?.studentEmail || '').trim().toLowerCase();
    const className = String(req.body?.className || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const password = String(req.body?.password || '').trim();

    if (!studentName || !studentEmail) {
      return res.status(400).json({ message: 'Student name and email are required.' });
    }

    const alreadyAssigned = await TeacherStudent.findOne({ studentEmail }).lean();
    if (alreadyAssigned?._id) {
      return res.status(400).json({ message: 'This student email is already assigned to another teacher.' });
    }

    const existingUser = await User.findOne({ email: studentEmail }).lean();
    if (existingUser?._id && String(existingUser.role || '').trim().toLowerCase() !== 'student') {
      return res.status(400).json({ message: 'This email is already used by a non-student account.' });
    }

    if (!existingUser?._id && password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters for new student portal access.' });
    }

    const created = await TeacherStudent.create({
      teacherUserId: teacher._id,
      teacherName: String(teacher.name || ''),
      teacherEmail: String(teacher.email || '').trim().toLowerCase(),
      teacherRole: String(teacher.role || '').trim().toLowerCase(),
      studentName,
      studentEmail,
      className,
      phone,
      notes,
    });

    if (!existingUser?._id) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.create({
        name: studentName,
        email: studentEmail,
        password: hashedPassword,
        role: 'student',
        class: className,
      });
    } else {
      await User.updateOne(
        { _id: existingUser._id },
        {
          $set: {
            name: studentName,
            class: className,
          },
        }
      );
    }

    return res.status(201).json({
      message: 'Student added successfully.',
      student: mapTeacherStudent(created),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'This student email is already added by you.' });
    }
    return res.status(500).json({ message: 'Failed to add student.', error: error?.message || error });
  }
});

app.post('/api/teacher-panel/submissions', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ message: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ message: 'Unauthorized. Please login again.' });
    }

    const context = await resolveTeacherPanelContext(authUser);
    if (!context.panelKey || !context.teacherUserId) {
      return res.status(403).json({ message: 'No teacher assignment found for this submission.' });
    }

    const studentEmail = String(req.body?.studentEmail || context.userEmail || '').trim().toLowerCase();
    if (!studentEmail) {
      return res.status(400).json({ message: 'Student email is required.' });
    }
    if (context.role === 'student' && studentEmail !== context.userEmail) {
      return res.status(403).json({ message: 'Students can only submit their own attempts.' });
    }

    const assignment = await TeacherStudent.findOne({
      teacherUserId: context.teacherUserId,
      studentEmail,
    }).lean();
    if (!assignment?._id) {
      return res.status(403).json({ message: 'This student is not assigned to the teacher.' });
    }

    const doc = await TeacherPanelState.findOne({ key: context.panelKey }).lean();
    const current = normalizeTeacherPanelData(doc?.data || EMPTY_TEACHER_PANEL_DATA);
    const submission = {
      id: String(req.body?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      source: String(req.body?.source || 'teacher'),
      examId: String(req.body?.examId || ''),
      examTitle: String(req.body?.examTitle || ''),
      studentName: String(req.body?.studentName || assignment.studentName || ''),
      studentEmail,
      className: String(req.body?.className || assignment.className || ''),
      subject: String(req.body?.subject || ''),
      score: Number(req.body?.score || 0),
      correct: Number(req.body?.correct || 0),
      wrong: Number(req.body?.wrong || 0),
      totalQuestions: Number(req.body?.totalQuestions || 0),
      submittedAt: String(req.body?.submittedAt || new Date().toISOString()),
    };

    const filtered = current.examSubmissions.filter((item) => String(item?.id || '') !== submission.id);
    const nextData = {
      ...current,
      examSubmissions: [submission, ...filtered].slice(0, 500),
    };

    await TeacherPanelState.findOneAndUpdate(
      { key: context.panelKey },
      { $set: { data: nextData } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return res.status(201).json({ message: 'Submission saved.', submission });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to save submission.', error: error?.message || error });
  }
});

app.delete('/api/teacher-panel/students/:id', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ message: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ message: 'Unauthorized. Please login again.' });
    }

    const teacher = await User.findById(authUser.id).select('role').lean();
    if (!teacher?._id || !isTeacherRole(teacher.role)) {
      return res.status(403).json({ message: 'Only teacher accounts can remove students.' });
    }

    const deleted = await TeacherStudent.findOneAndDelete({
      _id: req.params.id,
      teacherUserId: authUser.id,
    }).lean();

    if (!deleted?._id) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    return res.json({ message: 'Student removed successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to remove student.', error: error?.message || error });
  }
});

app.patch('/api/teacher-panel/students/:id', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ message: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ message: 'Unauthorized. Please login again.' });
    }

    const teacher = await User.findById(authUser.id).select('role').lean();
    if (!teacher?._id || !isTeacherRole(teacher.role)) {
      return res.status(403).json({ message: 'Only teacher accounts can edit students.' });
    }

    const studentName = String(req.body?.studentName || '').trim();
    const studentEmail = String(req.body?.studentEmail || '').trim().toLowerCase();
    const className = String(req.body?.className || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const notes = String(req.body?.notes || '').trim();

    if (!studentName || !studentEmail) {
      return res.status(400).json({ message: 'Student name and email are required.' });
    }

    const existingAssignment = await TeacherStudent.findOne({
      teacherUserId: authUser.id,
      studentEmail,
      _id: { $ne: req.params.id },
    }).lean();
    if (existingAssignment?._id) {
      return res.status(400).json({ message: 'This student email is already added by you.' });
    }

    const existingStudent = await TeacherStudent.findOne({
      _id: req.params.id,
      teacherUserId: authUser.id,
    }).lean();
    if (!existingStudent?._id) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    const updatedStudent = await TeacherStudent.findOneAndUpdate(
      { _id: req.params.id, teacherUserId: authUser.id },
      {
        $set: {
          studentName,
          studentEmail,
          className,
          phone,
          notes,
        },
      },
      { new: true, runValidators: true }
    ).lean();

    await User.updateOne(
      { email: String(existingStudent.studentEmail || '').trim().toLowerCase() },
      {
        $set: {
          name: studentName,
          email: studentEmail,
          class: className,
        },
      }
    );

    return res.json({
      message: 'Student updated successfully.',
      student: mapTeacherStudent(updatedStudent),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'This student email is already assigned.' });
    }
    return res.status(500).json({ message: 'Failed to update student.', error: error?.message || error });
  }
});

app.get('/api/user/profile', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }
    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }

    const user = await User.findById(authUser.id)
      .select('name email role class avatarUrl phone bio city state schoolName createdAt loginCount lastLoginAt')
      .lean();
    if (!user?._id) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const completion = getProfileCompletionState(user);

    return res.json({
      profile: {
        id: String(user._id),
        name: String(user.name || ''),
        email: String(user.email || ''),
        role: String(user.role || ''),
        className: String(user.class || ''),
        avatarUrl: String(user.avatarUrl || ''),
        phone: String(user.phone || ''),
        bio: String(user.bio || ''),
        city: String(user.city || ''),
        state: String(user.state || ''),
        schoolName: String(user.schoolName || ''),
        createdAt: user.createdAt,
        loginCount: Number(user.loginCount || 0),
        lastLoginAt: user.lastLoginAt || null,
        profileCompleted: completion.isComplete,
        needsClass: completion.needsClass,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch profile.', details: error?.message || error });
  }
});

app.patch('/api/user/profile', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }
    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }

    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const className = String(req.body?.className || '').trim();
    const role = String(req.body?.role || '').trim().toLowerCase();
    const avatarUrl = String(req.body?.avatarUrl || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const bio = String(req.body?.bio || '').trim();
    const city = String(req.body?.city || '').trim();
    const state = String(req.body?.state || '').trim();
    const schoolName = String(req.body?.schoolName || '').trim();

    const update = {};
    if (name) update.name = name;
    if (email) {
      const duplicate = await User.findOne({ email, _id: { $ne: authUser.id } }).lean();
      if (duplicate?._id) {
        return res.status(400).json({ error: 'Email already in use.' });
      }
      update.email = email;
    }
    const currentUser = await User.findById(authUser.id).select('role class').lean();
    if (!currentUser?._id) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (role) {
      if (!['student', 'individual_tutor', 'coaching_institute'].includes(role)) {
        return res.status(400).json({ error: 'Invalid account type.' });
      }
      update.role = role;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'className')) {
      update.class = className;
    }
    const nextRole = String(update.role || currentUser.role || '').trim().toLowerCase();
    const nextClassName = Object.prototype.hasOwnProperty.call(update, 'class')
      ? String(update.class || '').trim()
      : String(currentUser.class || '').trim();
    if (!['student', 'individual_tutor', 'coaching_institute'].includes(nextRole)) {
      return res.status(400).json({ error: 'Please select account type to complete your profile.' });
    }
    if (nextRole === 'student' && !nextClassName) {
      return res.status(400).json({ error: 'Please enter class to complete your profile.' });
    }
    update.avatarUrl = avatarUrl;
    update.phone = phone;
    update.bio = bio;
    update.city = city;
    update.state = state;
    update.schoolName = schoolName;

    const updated = await User.findByIdAndUpdate(authUser.id, { $set: update }, { new: true })
      .select('name email role class avatarUrl phone bio city state schoolName createdAt loginCount lastLoginAt')
      .lean();
    if (!updated?._id) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const completion = getProfileCompletionState(updated);

    return res.json({
      message: 'Profile updated successfully.',
      profile: {
        id: String(updated._id),
        name: String(updated.name || ''),
        email: String(updated.email || ''),
        role: String(updated.role || ''),
        className: String(updated.class || ''),
        avatarUrl: String(updated.avatarUrl || ''),
        phone: String(updated.phone || ''),
        bio: String(updated.bio || ''),
        city: String(updated.city || ''),
        state: String(updated.state || ''),
        schoolName: String(updated.schoolName || ''),
        createdAt: updated.createdAt,
        loginCount: Number(updated.loginCount || 0),
        lastLoginAt: updated.lastLoginAt || null,
        profileCompleted: completion.isComplete,
        needsClass: completion.needsClass,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update profile.', details: error?.message || error });
  }
});

async function buildLeaderboardOverview(currentUserId = '') {
  const completedWithUserMatch = {
    score: { $ne: null },
    userId: { $ne: null },
  };

  const [registeredUsers, groupedRows] = await Promise.all([
    User.countDocuments({}),
    ExamAttempt.aggregate([
      { $match: completedWithUserMatch },
      {
        $group: {
          _id: '$userId',
          avgScore: { $avg: '$score' },
          attempts: { $sum: 1 },
          bestScore: { $max: '$score' },
        },
      },
      {
        $project: {
          _id: 0,
          userId: { $toString: '$_id' },
          avgScore: { $round: ['$avgScore', 2] },
          attempts: 1,
          bestScore: 1,
        },
      },
      { $sort: { avgScore: -1, bestScore: -1, attempts: -1 } },
    ]),
  ]);

  const participants = groupedRows.length;
  const safeCurrentUserId = String(currentUserId || '');
  const currentUserIndex = safeCurrentUserId
    ? groupedRows.findIndex((row) => String(row.userId) === safeCurrentUserId)
    : -1;
  const yourRank = currentUserIndex >= 0 ? currentUserIndex + 1 : 0;
  const yourAverageScore = currentUserIndex >= 0 ? Number(groupedRows[currentUserIndex].avgScore || 0) : 0;

  const topRows = groupedRows.slice(0, 10);
  const topUserIds = topRows.map((row) => row.userId);
  const topUsers = await User.find({ _id: { $in: topUserIds } }).select('_id name email').lean();
  const userMap = new Map(topUsers.map((user) => [String(user._id), user]));

  const leaderboard = topRows.map((row, index) => {
    const user = userMap.get(String(row.userId));
    return {
      rank: index + 1,
      userId: row.userId,
      name: user?.name || 'User',
      email: user?.email || '',
      avgScore: Number(row.avgScore || 0),
      bestScore: Number(row.bestScore || 0),
      attempts: Number(row.attempts || 0),
    };
  });

  return {
    registeredUsers,
    participants,
    yourRank,
    yourAverageScore,
    leaderboard,
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/db', (req, res) => {
  res.json({
    status: 'ok',
    database: isDatabaseConnected() ? 'connected' : 'disconnected',
  });
});

function buildPdfStructureResponse(parsedData) {
  const chapters = getValidChapters(parsedData).map((chapterName) => {
    const topics = getValidTopics(parsedData, chapterName).map((topicName) => {
      const questionCount = parsedData?.[chapterName]?.topics?.[topicName]?.questions?.length || 0;
      return { name: topicName, questionCount };
    });

    const chapterQuestionCount = topics.reduce((count, topic) => count + (topic.questionCount || 0), 0);

    return { name: chapterName, questionCount: chapterQuestionCount, topics };
  });

  return { chapters, dataMap: parsedData };
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const clean = String(value || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function mergeParsedDataMaps(parsedMaps) {
  const merged = {};

  for (const rawMap of parsedMaps || []) {
    const validatedMap = validateParsedPDFData(rawMap);
    for (const [chapterName, chapterNode] of Object.entries(validatedMap)) {
      if (!merged[chapterName]) {
        merged[chapterName] = { topics: {} };
      }

      for (const [topicName, topicNode] of Object.entries(chapterNode?.topics || {})) {
        const existingTopic = merged[chapterName].topics[topicName] || {
          content: '',
          questions: [],
        };

        const mergedContent = uniqueStrings([existingTopic.content, topicNode?.content]).join('\n');
        const mergedQuestions = uniqueStrings([...(existingTopic.questions || []), ...(topicNode?.questions || [])]);

        merged[chapterName].topics[topicName] = {
          content: mergedContent,
          questions: mergedQuestions,
        };
      }
    }
  }

  return validateParsedPDFData(merged);
}

function normalizeQuizPayload(rawQuiz) {
  if (!Array.isArray(rawQuiz)) return [];
  const out = [];

  for (const item of rawQuiz) {
    if (!item || typeof item !== 'object') continue;
    const q = String(item.q || item.question || '').trim();
    const options = Array.isArray(item.options)
      ? item.options.map((opt) => String(opt || '').trim()).filter(Boolean)
      : [];
    const ans = String(item.ans || item.answer || '').trim();
    const exp = String(item.exp || item.explanation || '').trim();
    const userAnswer = String(item.userAnswer || item.selectedAnswer || '').trim();

    if (!q) continue;
    out.push({ q, options, ans, exp, userAnswer });
  }

  return out;
}

async function parseAndMergeUploadedPdfs(files) {
  const uploadedFiles = Array.isArray(files) ? files.filter((file) => file?.buffer) : [];
  if (uploadedFiles.length === 0) {
    return { fullPdfText: '', parsedData: {} };
  }

  const parsedMaps = [];
  const allText = [];
  for (const file of uploadedFiles) {
    const text = await extractTextFromPDF(file.buffer);
    allText.push(text);
    parsedMaps.push(parsePdfTextToStructuredData(text));
  }

  return {
    fullPdfText: allText.filter(Boolean).join('\n\n'),
    parsedData: mergeParsedDataMaps(parsedMaps),
  };
}

app.post('/api/pdf-structure', upload.array('pdf', 10), async (req, res) => {
  try {
    const files = req.files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const { parsedData } = await parseAndMergeUploadedPdfs(files);
    const response = buildPdfStructureResponse(parsedData);

    return res.json(response);
  } catch (error) {
    const message = error?.message || 'Failed to process PDF.';
    console.error('PDF Structure Error:', message);
    return res.status(400).json({ error: 'Unable to parse chapter/topic structure from this PDF.' });
  }
});

app.post('/api/generate-questions', upload.array('pdf', 10), async (req, res) => {
  try {
    const { source, chapter, topic, difficulty, numQ } = req.body;
    let fullPdfText = '';
    let parsedData = {};
    const files = req.files;
    const authUser = getAuthUserFromRequest(req);
    const isAuthenticated = Boolean(authUser?.id);

    if (!source) {
      return res.status(400).json({ error: 'Missing required field: source' });
    }

    if (source === 'other' && (!Array.isArray(files) || files.length === 0)) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    if (source !== 'ncert' && source !== 'other') {
      return res.status(400).json({ error: 'Invalid source. Expected: ncert | other' });
    }

    let quotaBefore = null;
    if (isAuthenticated) {
      const teacherAssignment = await getTeacherManagedStudentAssignment(authUser);
      if (teacherAssignment?._id) {
        return res.status(403).json({
          error: 'Teacher-created student accounts can use only the dashboard. Start new assessment is disabled.',
          code: 'assessment_generation_disabled',
          access: {
            sourceType: 'teacher_student',
            canStartAssessments: false,
            canBuyPlan: false,
            teacherName: String(teacherAssignment.teacherName || ''),
            teacherEmail: String(teacherAssignment.teacherEmail || '').trim().toLowerCase(),
          },
        });
      }

      quotaBefore = await getUserQuota(authUser.id);
      if (quotaBefore.remainingExamCredits <= 0) {
        return res.status(402).json({
          error: 'Exam credit limit reached. Please buy a plan to continue.',
          code: 'quota_exceeded',
          quota: quotaBefore,
        });
      }
    }

    if (source === 'other') {
      const mergedPdfData = await parseAndMergeUploadedPdfs(files);
      fullPdfText = mergedPdfData.fullPdfText;
      parsedData = mergedPdfData.parsedData;
    }

    const quizData = await safeGenerateExam({
      generateQuizFn: generateQuiz,
      source,
      difficulty,
      numQ,
      chapter,
      topic,
      className: req.body.class,
      subject: req.body.subject,
      fullPdfText,
      parsedData,
    });

    if (!Array.isArray(quizData?.quiz) || quizData.quiz.length === 0) {
      console.warn('Generate Questions: safe fallback produced no quiz items.');
      return res.status(500).json({
        error: 'Unable to generate questions from the selected content.',
      });
    }

    if (!isAuthenticated) {
      return res.json({
        ...quizData,
        quota: null,
      });
    }

    const consumeResult = await consumeOneExamCredit(authUser.id);
    if (!consumeResult.ok) {
      return res.status(402).json({
        error: 'Exam credit limit reached. Please buy a plan to continue.',
        code: 'quota_exceeded',
        quota: consumeResult.quota,
      });
    }

    return res.json({
      ...quizData,
      quota: consumeResult.quota,
    });
  } catch (error) {
    const message = error?.message || 'Internal Server Error';
    console.error('Server Error:', message);

    if (message.startsWith('Failed to read PDF file')) {
      return res.status(400).json({ error: message });
    }

    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/exam-attempts', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }
    const clientAttemptId =
      typeof req.body.clientAttemptId === 'string' ? req.body.clientAttemptId.trim() : '';
    const reviewHTML = typeof req.body.reviewHTML === 'string' ? req.body.reviewHTML : '';
    const quiz = normalizeQuizPayload(req.body.quiz);

    const payload = {
      userId: authUser?.id || null,
      source: req.body.source,
      className: req.body.className || '',
      subject: req.body.subject || '',
      chapter: req.body.chapter || '',
      topic: req.body.topic || '',
      difficulty: req.body.difficulty || 'Medium',
      numQuestions: Number(req.body.numQuestions) || 0,
      generatedQuestionCount: Number(req.body.generatedQuestionCount) || 0,
      score: Number.isFinite(Number(req.body.score)) ? Number(req.body.score) : null,
      correct: Number.isFinite(Number(req.body.correct)) ? Number(req.body.correct) : null,
      wrong: Number.isFinite(Number(req.body.wrong)) ? Number(req.body.wrong) : null,
      totalQuestions: Number.isFinite(Number(req.body.totalQuestions)) ? Number(req.body.totalQuestions) : null,
      reviewHTML,
      quiz,
      usedLocalFallback: Boolean(req.body.usedLocalFallback),
    };

    if (clientAttemptId) {
      payload.clientAttemptId = clientAttemptId;
    }

    if (!payload.source) {
      return res.status(400).json({ error: 'Missing required field: source' });
    }

    if (clientAttemptId) {
      const existingAttempt = await ExamAttempt.findOne({ clientAttemptId }).lean();
      if (existingAttempt?._id) {
        const shouldPatchExisting =
          (quiz.length > 0 && (!Array.isArray(existingAttempt.quiz) || existingAttempt.quiz.length === 0)) ||
          (reviewHTML && !existingAttempt.reviewHTML);

        if (shouldPatchExisting) {
          await ExamAttempt.updateOne(
            { _id: existingAttempt._id },
            {
              $set: {
                ...(quiz.length > 0 ? { quiz } : {}),
                ...(reviewHTML ? { reviewHTML } : {}),
              },
            }
          );
        }

        return res.status(200).json({
          message: 'Exam attempt already exists.',
          id: existingAttempt._id,
          duplicate: true,
        });
      }
    }

    const created = await ExamAttempt.create(payload);
    return res.status(201).json({ message: 'Exam attempt saved.', id: created._id });
  } catch (error) {
    if (error?.code === 11000) {
      const clientAttemptId =
        typeof req.body.clientAttemptId === 'string' ? req.body.clientAttemptId.trim() : '';
      if (clientAttemptId) {
        const existingAttempt = await ExamAttempt.findOne({ clientAttemptId }).lean();
        if (existingAttempt?._id) {
          return res.status(200).json({
            message: 'Exam attempt already exists.',
            id: existingAttempt._id,
            duplicate: true,
          });
        }
      }
    }

    console.error('Save Attempt Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to save exam attempt.' });
  }
});

app.post('/api/assistant/ask', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }

    const question = String(req.body?.question || '').trim();
    if (!question || question.length < 3) {
      return res.status(400).json({ error: 'Question is too short.' });
    }

    const result = await solveDoubt(question);
    const created = await AssistantRecord.create({
      userId: authUser.id,
      question,
      answer: result.answer,
      modelUsed: result.modelUsed || 'fallback',
      status: result.status === 'resolved' ? 'resolved' : 'fallback',
    });

    return res.json({
      answer: created.answer,
      record: {
        id: String(created._id),
        question: created.question,
        answer: created.answer,
        status: created.status,
        modelUsed: created.modelUsed,
        createdAt: created.createdAt,
      },
    });
  } catch (error) {
    console.error('Assistant Ask Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to resolve doubt.' });
  }
});

app.get('/api/assistant/history', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const records = await AssistantRecord.find({ userId: authUser.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      count: records.length,
      records: records.map((item) => ({
        id: String(item._id),
        question: item.question || '',
        answer: item.answer || '',
        status: item.status || 'resolved',
        modelUsed: item.modelUsed || 'fallback',
        createdAt: item.createdAt,
      })),
    });
  } catch (error) {
    console.error('Assistant History Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to fetch assistant history.' });
  }
});

app.get('/api/exam-attempts', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const attempts = await ExamAttempt.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ count: attempts.length, attempts });
  } catch (error) {
    console.error('Fetch Attempts Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to fetch exam attempts.' });
  }
});

app.get('/api/exam-attempts/:id', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }

    const attemptId = String(req.params.id || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(attemptId)) {
      return res.status(400).json({ error: 'Invalid exam attempt id.' });
    }

    const attempt = await ExamAttempt.findOne({
      _id: attemptId,
      $or: [
        { userId: authUser.id },
        { userId: null },
        { userId: { $exists: false } },
      ],
    }).lean();

    if (!attempt) {
      return res.status(404).json({ error: 'Exam attempt not found.' });
    }

    return res.json({
      attempt: {
        id: String(attempt._id),
        source: attempt.source || 'ncert',
        className: attempt.className || '',
        subject: attempt.subject || '',
        chapter: attempt.chapter || '',
        topic: attempt.topic || '',
        difficulty: attempt.difficulty || 'Medium',
        score: Number.isFinite(Number(attempt.score)) ? Number(attempt.score) : null,
        correct: Number.isFinite(Number(attempt.correct)) ? Number(attempt.correct) : null,
        wrong: Number.isFinite(Number(attempt.wrong)) ? Number(attempt.wrong) : null,
        totalQuestions: Number.isFinite(Number(attempt.totalQuestions)) ? Number(attempt.totalQuestions) : null,
        reviewHTML: typeof attempt.reviewHTML === 'string' ? attempt.reviewHTML : '',
        quiz: normalizeQuizPayload(attempt.quiz),
        questions: normalizeQuizPayload(attempt.quiz),
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      },
    });
  } catch (error) {
    console.error('Fetch Attempt By Id Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to fetch exam attempt.' });
  }
});

app.delete('/api/exam-attempts/:id', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    if (!authUser?.id) {
      return res.status(401).json({ error: 'Unauthorized. Please login again.' });
    }

    const deleted = await ExamAttempt.findOneAndDelete({
      _id: req.params.id,
      $or: [
        { userId: authUser.id },
        { userId: null },
        { userId: { $exists: false } },
      ],
    });
    if (!deleted) {
      return res.status(404).json({ error: 'Exam attempt not found.' });
    }

    return res.json({ message: 'Exam attempt deleted.' });
  } catch (error) {
    console.error('Delete Attempt Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to delete exam attempt.' });
  }
});

app.get('/api/dashboard/overview', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const completedMatch = { score: { $ne: null } };

    const [scoredCount, scoredAgg, currentMonthCount, previousMonthCount, recentAttempts, leaderboardOverview] =
      await Promise.all([
        ExamAttempt.countDocuments(completedMatch),
        ExamAttempt.aggregate([
          { $match: completedMatch },
          { $group: { _id: null, avgScore: { $avg: '$score' } } },
        ]),
        ExamAttempt.countDocuments({
          ...completedMatch,
          createdAt: { $gte: startOfCurrentMonth, $lt: startOfNextMonth },
        }),
        ExamAttempt.countDocuments({
          ...completedMatch,
          createdAt: { $gte: startOfPreviousMonth, $lt: startOfCurrentMonth },
        }),
        ExamAttempt.find(completedMatch).sort({ createdAt: -1 }).limit(5).lean(),
        buildLeaderboardOverview(authUser?.id || ''),
      ]);

    const totalAssessments = scoredCount;
    const avgScore = Number(scoredAgg?.[0]?.avgScore || 0);
    const completionRate = totalAssessments > 0 ? 100 : 0;
    const growth = currentMonthCount - previousMonthCount;

    const monthlyScores = [];
    for (let i = 5; i >= 0; i -= 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const [monthAgg] = await ExamAttempt.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart, $lt: monthEnd },
            ...completedMatch,
          },
        },
        { $group: { _id: null, avgScore: { $avg: '$score' } } },
      ]);
      monthlyScores.push(Math.round(Number(monthAgg?.avgScore || 0)));
    }

    const activities = recentAttempts.map((attempt) => ({
      title: attempt.score == null ? 'Assessment Generated' : 'Exam Completed',
      detail:
        attempt.score == null
          ? `${attempt.chapter || 'Unknown chapter'} (${attempt.topic || 'General Topic'}) is ready.`
          : `Score ${Math.round(attempt.score)}% in ${attempt.chapter || 'assessment'}.`,
      time: new Date(attempt.createdAt).toLocaleString('en-US'),
    }));

    const assessments = recentAttempts.slice(0, 3).map((attempt) => ({
      title: attempt.chapter || 'Assessment',
      chapter: `${attempt.className || 'General'} | ${attempt.topic || 'General Topic'}`,
      date: new Date(attempt.createdAt).toLocaleString('en-US'),
      status: attempt.score == null ? 'Pending' : 'Completed',
    }));

    return res.json({
      stats: {
        totalAssessments,
        averageScore: Math.round(avgScore),
        completionRate: Math.round(completionRate),
        leaderboardRank: Number(leaderboardOverview.yourRank || 0),
        registeredUsers: Number(leaderboardOverview.registeredUsers || 0),
        participants: Number(leaderboardOverview.participants || 0),
        monthlyGrowth: growth,
      },
      monthlyScores,
      activities,
      assessments,
    });
  } catch (error) {
    console.error('Dashboard Overview Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to fetch dashboard overview.' });
  }
});

app.get('/api/dashboard/metrics', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const completedMatch = { score: { $ne: null } };
    const userScopedMatch = authUser?.id
      ? {
          ...completedMatch,
          $or: [
            { userId: authUser.id },
            { userId: null },
            { userId: { $exists: false } },
          ],
        }
      : completedMatch;

    const [totalAssessments, scoredAgg, passedCount, currentMonthCount, previousMonthCount, attempts, leaderboardOverview] =
      await Promise.all([
        ExamAttempt.countDocuments(userScopedMatch),
        ExamAttempt.aggregate([
          { $match: userScopedMatch },
          { $group: { _id: null, avgScore: { $avg: '$score' } } },
        ]),
        ExamAttempt.countDocuments({ ...userScopedMatch, score: { $gte: 40 } }),
        ExamAttempt.countDocuments({ ...userScopedMatch, createdAt: { $gte: startOfCurrentMonth } }),
        ExamAttempt.countDocuments({
          ...userScopedMatch,
          createdAt: { $gte: startOfPreviousMonth, $lt: startOfCurrentMonth },
        }),
        ExamAttempt.find(userScopedMatch)
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean(),
        buildLeaderboardOverview(authUser?.id || ''),
      ]);

    const averageScore = Math.round(Number(scoredAgg?.[0]?.avgScore || 0));
    const passRate = totalAssessments > 0 ? Math.round((passedCount / totalAssessments) * 100) : 0;
    const monthlyGrowth = currentMonthCount - previousMonthCount;

    return res.json({
      stats: {
        totalAssessments,
        averageScore,
        completionRate: totalAssessments > 0 ? 100 : 0,
        leaderboardRank: Number(leaderboardOverview.yourRank || 0),
        registeredUsers: Number(leaderboardOverview.registeredUsers || 0),
        participants: Number(leaderboardOverview.participants || 0),
        yourAverageScore: Number(leaderboardOverview.yourAverageScore || 0),
        monthlyGrowth,
        passRate,
      },
      leaderboard: leaderboardOverview.leaderboard,
      attempts: attempts.map((attempt) => ({
        id: String(attempt._id),
        source: attempt.source || 'ncert',
        className: attempt.className || '',
        subject: attempt.subject || '',
        chapter: attempt.chapter || '',
        topic: attempt.topic || '',
        difficulty: attempt.difficulty || 'Medium',
        score: Number(attempt.score || 0),
        correct: Number(attempt.correct || 0),
        wrong: Number(attempt.wrong || 0),
        totalQuestions: Number(attempt.totalQuestions || 0),
        createdAt: attempt.createdAt,
      })),
    });
  } catch (error) {
    console.error('Dashboard Metrics Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to fetch dashboard metrics.' });
  }
});

app.get('/api/leaderboard/overview', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const authUser = getAuthUserFromRequest(req);
    const leaderboardOverview = await buildLeaderboardOverview(authUser?.id || '');

    return res.json({
      registeredUsers: Number(leaderboardOverview.registeredUsers || 0),
      participants: Number(leaderboardOverview.participants || 0),
      yourRank: Number(leaderboardOverview.yourRank || 0),
      yourAverageScore: Number(leaderboardOverview.yourAverageScore || 0),
      leaderboard: leaderboardOverview.leaderboard,
    });
  } catch (error) {
    console.error('Leaderboard Overview Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to fetch leaderboard overview.' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const maxBookUploadSizeMb = Math.max(5, Number(process.env.BOOK_UPLOAD_MAX_FILE_SIZE_MB) || 80);
    const maxBookUploadFiles = Math.max(1, Number(process.env.BOOK_UPLOAD_MAX_FILES) || 10);
    const errorMessage =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Uploaded PDF is too large. Max allowed size is ${maxBookUploadSizeMb} MB per file.`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `Too many files uploaded. Max allowed files per request is ${maxBookUploadFiles}.`
          : err.message;

    return res.status(statusCode).json({
      error: errorMessage,
      code: err.code,
    });
  }

  return next(err);
});

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  (async () => {
    await connectToDatabase();
    await ensureDefaultPlans();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })();
}

module.exports = { app };
