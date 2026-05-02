const mongoose = require('mongoose');

const assistantRecordSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    question: { type: String, required: true, trim: true, maxlength: 2000 },
    answer: { type: String, required: true, trim: true, maxlength: 10000 },
    modelUsed: { type: String, default: 'fallback', trim: true },
    status: { type: String, enum: ['resolved', 'fallback'], default: 'resolved' },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.AssistantRecord ||
  mongoose.model('AssistantRecord', assistantRecordSchema);
