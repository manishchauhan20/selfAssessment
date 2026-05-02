const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const TeacherStudent = require("../models/TeacherStudent");
const { buildQuotaSnapshot } = require("../utils/quotaManager");

const router = express.Router();
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || "http://localhost:3000").trim();

let mailTransporter = null;

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

function decodeBase64Url(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  if (!normalized) {
    throw new Error("Token payload is missing.");
  }

  const padding = normalized.length % 4;
  const padded = padding ? normalized.padEnd(normalized.length + (4 - padding), "=") : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseExternalToken(rawToken) {

  const normalizedToken = String(rawToken || "").trim();
  if (!normalizedToken) {
    throw new Error("Token is required.");
  }

  const [encodedPayload] = normalizedToken.split(".");
  const decodedPayload = decodeBase64Url(encodedPayload);
  const payload = JSON.parse(decodedPayload);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid token payload.");
  }

   if (payload.exp && (Number(payload.exp) * 1000 + 5 * 60 * 1000) <= Date.now()) {
  throw new Error("Token has expired.");
}

  return payload;
}

async function buildLoginResponse(user, req) {
  const profileCompletion = getProfileCompletionState(user);
  const normalizedEmail = String(user?.email || "").trim().toLowerCase();
  const normalizedRole = String(user?.role || "").trim().toLowerCase();
  const teacherAssignment =
    normalizedRole === "student" && normalizedEmail
      ? await TeacherStudent.findOne({ studentEmail: normalizedEmail })
          .sort({ createdAt: -1 })
          .select("teacherUserId teacherName teacherEmail teacherRole className")
          .lean()
      : null;
  const isTeacherManagedStudent = Boolean(teacherAssignment?._id);
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

  const token = jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET || "mySecretKey",
    { expiresIn: "1d" }
  );

  return {
    message: "Login successful",
    token,
    role: user.role,
    name: user.name,
    email: user.email,
    className: teacherAssignment?.className || user.class || "",
    profileCompleted: profileCompletion.isComplete,
    quota: buildQuotaSnapshot(user),
    sourceType: isTeacherManagedStudent ? "teacher_student" : "user",
    teacherManagedStudent: isTeacherManagedStudent,
    canStartAssessments: !isTeacherManagedStudent,
    canBuyPlan: !isTeacherManagedStudent,
    teacherAssignment: teacherAssignment
      ? {
          teacherUserId: String(teacherAssignment.teacherUserId || ""),
          teacherName: String(teacherAssignment.teacherName || ""),
          teacherEmail: String(teacherAssignment.teacherEmail || "").trim().toLowerCase(),
          teacherRole: String(teacherAssignment.teacherRole || ""),
          className: String(teacherAssignment.className || ""),
        }
      : null,
  };
}

function normalizeIncomingRole(value) {
  const normalizedRole = String(value || "pending").trim().toLowerCase();

  if (
    normalizedRole === "individual_teacher" ||
    normalizedRole === "indivisual_teacher" ||
    normalizedRole === "individual tutor"
  ) {
    return "individual_tutor";
  }

  if (
    normalizedRole === "coaching_teacher" ||
    normalizedRole === "coaching institute" ||
    normalizedRole === "coaching_teacher"
  ) {
    return "coaching_institute";
  }

  return normalizedRole;
}

function getLoginAudience(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (normalizedValue === "teacher") return "teacher";
  return "student";
}

function isTeacherRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return normalizedRole === "individual_tutor" || normalizedRole === "coaching_institute";
}

function getMailTransporter() {
  if (mailTransporter) return mailTransporter;

  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const secure = String(process.env.SMTP_SECURE || "false").trim().toLowerCase() === "true";
  const gmailUser = String(process.env.EMAIL_USER || "").trim();
  const gmailPass = String(process.env.APP_PASSWORD || "").trim().replace(/\s+/g, "");

  if (host && user && pass) {
    mailTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    return mailTransporter;
  }

  if (gmailUser && gmailPass) {
    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailPass,
      },
    });
    return mailTransporter;
  }

  return null;
}

async function sendResetMail({ toEmail, resetLink }) {
  const fromEmail = String(
    process.env.SMTP_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || ""
  ).trim();
  const transporter = getMailTransporter();

  if (!transporter || !fromEmail) {
    console.warn("[ForgotPassword] SMTP not configured. Reset link:", resetLink);
    return { sent: false };
  }

  try {
    await transporter.sendMail({
      from: `"ExamGenius" <${fromEmail}>`,
      to: toEmail,
      subject: "Password Reset Request",
      html: `
        <div style="font-family: Arial, sans-serif; color: #0f172a;">
          <h2 style="margin-bottom: 8px;">Reset your password</h2>
          <p style="margin: 0 0 12px;">We received a request to reset your account password.</p>
          <p style="margin: 0 0 16px;">
            <a href="${resetLink}" style="display: inline-block; background: #4f46e5; color: #fff; text-decoration: none; padding: 10px 14px; border-radius: 8px;">
              Reset Password
            </a>
          </p>
          <p style="margin: 0 0 8px;">If you did not request this, you can ignore this email.</p>
          <p style="margin: 0; color: #475569;">This link expires in 30 minutes.</p>
        </div>
      `,
    });
  } catch (error) {
    console.error("[ForgotPassword] sendMail failed:", error?.message || error);
    throw error;
  }

  return { sent: true };
}


// =============================
// 🔹 SIGNUP ROUTE
// =============================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, role, class: studentClass } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedRole = normalizeIncomingRole(role);
    const normalizedClass = String(studentClass || "").trim();

    // Validation
    if (!name || !normalizedEmail || !password) {
      return res.status(400).json({ message: "All required fields must be filled" });
    }
    if (!["student", "individual_tutor", "coaching_institute", "pending"].includes(normalizedRole)) {
      return res.status(400).json({ message: "Invalid role" });
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
      class: normalizedRole === "student" ? normalizedClass : undefined,
    });

    await newUser.save();

    return res.status(201).json(await buildLoginResponse(newUser, req));

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
    const { email, password, loginAs } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const audience = getLoginAudience(loginAs);

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

    if (audience === "teacher" && !isTeacherRole(user.role)) {
      return res.status(403).json({ message: "This account is not allowed in the teacher panel." });
    }

    if (audience === "student" && isTeacherRole(user.role)) {
      return res.status(403).json({ message: "Please use teacher login for this account." });
    }

    res.json(await buildLoginResponse(user, req));

  } catch (error) {
    res.status(500).json({
      message: "Login failed",
      error: error.message,
    });
  }
});

router.post("/external-login", async (req, res) => {
  try {
    const externalToken = String(req.body?.token || req.query?.token || "").trim();
    if (!externalToken) {
      return res.status(400).json({ message: "Token is required" });
    }

    const payload = parseExternalToken(externalToken);
    
    const normalizedEmail = String(payload?.email || "").trim().toLowerCase();
   // const externalPassword = String(payload?.password || "").trim();

    if (!normalizedEmail) {
      return res.status(400).json({ message: "Token does not contain email" });
    }

    const user = await User.findOne({ email: normalizedEmail });
    
    if (!user) {
      return res.status(404).json({ message: "No account found for this token email" });
    }
    console.log("[ExternalLogin] Found user:", { id: user._id, email: user.email });
    // if (externalPassword) {
    //   const isMatch = await bcrypt.compare(externalPassword, user.password);
    //   if (!isMatch) {
    //     return res.status(401).json({ message: "Token password does not match local account" });
    //   }
    // }

    return res.json({
      ...(await buildLoginResponse(user, req)),
      externalIdentity: {
        name: String(payload?.name || user.name || "").trim(),
        email: normalizedEmail,
        role: String(payload?.role || "").trim().toLowerCase(),
      },
    });
  } catch (error) {
    return res.status(400).json({
      message: "External token login failed",
      error: error?.message || error,
    });
  }
});

router.post("/change-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const newPassword = String(req.body?.newPassword || "").trim();

    if (!email || !newPassword) {
      return res.status(400).json({ message: "Email and newPassword are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long" });
    }

    const user = await User.findOne({ email });
    if (!user?._id) {
      return res.status(404).json({ message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          password: hashedPassword,
          resetPasswordTokenHash: "",
          resetPasswordExpiresAt: null,
        },
      }
    );

    return res.json({ message: "Password changed successfully" });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to change password",
      error: error?.message || error,
    });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const user = await User.findOne({ email });
    if (user?._id) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            resetPasswordTokenHash: tokenHash,
            resetPasswordExpiresAt: expiresAt,
          },
        }
      );

      const resetLink = `${FRONTEND_BASE_URL}/reset-password?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`;
      await sendResetMail({ toEmail: email, resetLink });
    }

    return res.json({
      message: "If this email is registered, reset instructions have been sent.",
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to process forgot password request.",
      error: error?.message || error,
    });
  }
});

router.post("/reset-password/verify", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const token = String(req.body?.token || "").trim();

    if (!email || !token) {
      return res.status(400).json({ message: "Email and token are required." });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      email,
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() },
    }).lean();

    if (!user?._id) {
      return res.status(400).json({ message: "Invalid or expired reset link." });
    }

    return res.json({ message: "Token is valid." });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to verify reset link.",
      error: error?.message || error,
    });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!email || !token || !password) {
      return res.status(400).json({ message: "Email, token and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      email,
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() },
    });

    if (!user?._id) {
      return res.status(400).json({ message: "Invalid or expired reset link." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    user.resetPasswordTokenHash = "";
    user.resetPasswordExpiresAt = null;
    await user.save();

    return res.json({ message: "Password reset successful. Please login." });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to reset password.",
      error: error?.message || error,
    });
  }
});

module.exports = router;
