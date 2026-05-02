const mongoose = require('mongoose');

const adminCredentialSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.AdminCredential ||
  mongoose.model('AdminCredential', adminCredentialSchema);
