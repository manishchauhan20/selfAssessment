const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('./env');

const { connectToDatabase, isDatabaseConnected } = require('./config/database');
const ExamAttempt = require('./models/ExamAttempt');
const authRoutes = require('./routes/authRoutes');

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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);

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

    if (!source) {
      return res.status(400).json({ error: 'Missing required field: source' });
    }

    if (source === 'other') {
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'No PDF file uploaded' });
      }

      const mergedPdfData = await parseAndMergeUploadedPdfs(files);
      fullPdfText = mergedPdfData.fullPdfText;
      parsedData = mergedPdfData.parsedData;
    } else if (source !== 'ncert') {
      return res.status(400).json({ error: 'Invalid source. Expected: ncert | other' });
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

    if (isDatabaseConnected()) {
      try {
        await ExamAttempt.create({
          source,
          className: req.body.class || '',
          subject: req.body.subject || '',
          chapter: chapter || '',
          topic: topic || '',
          difficulty: difficulty || 'Medium',
          numQuestions: Number(numQ) || 5,
          generatedQuestionCount: quizData.quiz.length,
          usedLocalFallback: Boolean(quizData.usedLocalFallback),
        });
      } catch (dbError) {
        console.error('Failed to store generated attempt:', dbError?.message || dbError);
      }
    }

    return res.json(quizData);
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

    const payload = {
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
      violations: Number(req.body.violations) || 0,
      totalQuestions: Number.isFinite(Number(req.body.totalQuestions)) ? Number(req.body.totalQuestions) : null,
      usedLocalFallback: Boolean(req.body.usedLocalFallback),
    };

    if (!payload.source) {
      return res.status(400).json({ error: 'Missing required field: source' });
    }

    const created = await ExamAttempt.create(payload);
    return res.status(201).json({ message: 'Exam attempt saved.', id: created._id });
  } catch (error) {
    console.error('Save Attempt Error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to save exam attempt.' });
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

app.get('/api/dashboard/overview', async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [totalAssessments, scoredCount, scoredAgg, currentMonthCount, previousMonthCount, recentAttempts] =
      await Promise.all([
        ExamAttempt.countDocuments({}),
        ExamAttempt.countDocuments({ score: { $ne: null } }),
        ExamAttempt.aggregate([
          { $match: { score: { $ne: null } } },
          { $group: { _id: null, avgScore: { $avg: '$score' } } },
        ]),
        ExamAttempt.countDocuments({ createdAt: { $gte: startOfCurrentMonth, $lt: startOfNextMonth } }),
        ExamAttempt.countDocuments({ createdAt: { $gte: startOfPreviousMonth, $lt: startOfCurrentMonth } }),
        ExamAttempt.find({}).sort({ createdAt: -1 }).limit(5).lean(),
      ]);

    const avgScore = Number(scoredAgg?.[0]?.avgScore || 0);
    const completionRate = totalAssessments > 0 ? (scoredCount / totalAssessments) * 100 : 0;
    const growth = currentMonthCount - previousMonthCount;

    const monthlyScores = [];
    for (let i = 5; i >= 0; i -= 1) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const [monthAgg] = await ExamAttempt.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart, $lt: monthEnd },
            score: { $ne: null },
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
        leaderboardRank: totalAssessments > 0 ? Math.max(1, 100 - Math.round(avgScore)) : 0,
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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(statusCode).json({ error: err.message });
  }

  return next(err);
});

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  (async () => {
    await connectToDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })();
}

module.exports = { app };
