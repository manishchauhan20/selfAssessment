const mongoose = require('mongoose');

const teacherPanelStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.models.TeacherPanelState || mongoose.model('TeacherPanelState', teacherPanelStateSchema);
