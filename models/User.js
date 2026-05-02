const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ["student", "individual_tutor", "coaching_institute", "pending"],
    default: "pending"
  },
  class: {
    type: String
  },
  avatarUrl: {
    type: String,
    default: ""
  },
  phone: {
    type: String,
    default: ""
  },
  bio: {
    type: String,
    default: ""
  },
  city: {
    type: String,
    default: ""
  },
  state: {
    type: String,
    default: ""
  },
  schoolName: {
    type: String,
    default: ""
  },
  loginCount: {
    type: Number,
    default: 0
  },
  lastLoginAt: {
    type: Date,
    default: null
  },
  lastLoginIp: {
    type: String,
    default: ""
  },
  resetPasswordTokenHash: {
    type: String,
    default: ""
  },
  resetPasswordExpiresAt: {
    type: Date,
    default: null
  },
  freeExamLimit: {
    type: Number,
    default: 6,
    min: 0
  },
  bonusExamCredits: {
    type: Number,
    default: 0,
    min: 0
  },
  usedExamCredits: {
    type: Number,
    default: 0,
    min: 0
  },
  lifetimeExamCreditsPurchased: {
    type: Number,
    default: 0,
    min: 0
  }
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
