const mongoose = require('mongoose');

const teacherStudentSchema = new mongoose.Schema(
  {
    teacherUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    teacherName: {
      type: String,
      default: '',
      trim: true,
    },
    teacherEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    teacherRole: {
      type: String,
      enum: ['individual_tutor', 'coaching_institute'],
      required: true,
    },
    studentName: {
      type: String,
      required: true,
      trim: true,
    },
    studentEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    className: {
      type: String,
      default: '',
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

teacherStudentSchema.index({ teacherUserId: 1, studentEmail: 1 }, { unique: true });

module.exports =
  mongoose.models.TeacherStudent || mongoose.model('TeacherStudent', teacherStudentSchema);
