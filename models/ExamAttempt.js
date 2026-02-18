const { mongoose } = require('../config/database');

const examAttemptSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['ncert', 'other'], required: true },
    className: { type: String, default: '' },
    subject: { type: String, default: '' },
    chapter: { type: String, default: '' },
    topic: { type: String, default: '' },
    difficulty: { type: String, default: 'Medium' },
    numQuestions: { type: Number, min: 1, default: 5 },
    generatedQuestionCount: { type: Number, min: 0, default: 0 },
    score: { type: Number, min: 0, max: 100, default: null },
    correct: { type: Number, min: 0, default: null },
    wrong: { type: Number, min: 0, default: null },
    violations: { type: Number, min: 0, default: 0 },
    totalQuestions: { type: Number, min: 0, default: null },
    usedLocalFallback: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.ExamAttempt || mongoose.model('ExamAttempt', examAttemptSchema);
