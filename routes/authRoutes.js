const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();


// =============================
// 🔹 SIGNUP ROUTE
// =============================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, role, class: studentClass } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedRole = String(role || "").trim().toLowerCase();

    // Validation
    if (!name || !normalizedEmail || !password || !normalizedRole) {
      return res.status(400).json({ message: "All required fields must be filled" });
    }
    if (!["school", "plus", "general"].includes(normalizedRole)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    if (normalizedRole === "school" && !studentClass) {
      return res.status(400).json({ message: "Class is required for school role" });
    }

    // Check existing user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const newUser = new User({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      role: normalizedRole,
      class: normalizedRole === "school" ? studentClass : undefined
    });

    await newUser.save();

    res.status(201).json({
      message: "Signup successful",
    });

  } catch (error) {
    res.status(500).json({
      message: "Signup failed",
      error: error.message,
    });
  }
});


// =============================
// 🔹 LOGIN ROUTE
// =============================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Check user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(400).json({ message: "Invalid email" });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid password" });
    }

    // Track login details in DB so login activity is visible.
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          lastLoginAt: new Date(),
          lastLoginIp: req.ip || req.headers["x-forwarded-for"] || "",
        },
        $inc: { loginCount: 1 },
      }
    );

    // Create token
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || "mySecretKey",
      { expiresIn: "1d" }
    );

    res.json({
      message: "Login successful",
      token,
      role: user.role,
      name: user.name
    });

  } catch (error) {
    res.status(500).json({
      message: "Login failed",
      error: error.message,
    });
  }
});

module.exports = router;
