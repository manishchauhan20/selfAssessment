const mongoose = require('mongoose');

const bookSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    className: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sourceFileName: {
      type: String,
      default: '',
      trim: true,
    },
    parsedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    chapterCount: {
      type: Number,
      default: 0,
    },
    topicCount: {
      type: Number,
      default: 0,
    },
    questionCount: {
      type: Number,
      default: 0,
    },
    createdByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminCredential',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Book', bookSchema);
