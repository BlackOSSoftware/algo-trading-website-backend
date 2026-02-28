const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  findUserByEmail,
  findUserById,
  createUser,
  ensureUserPlan,
  buildPlan,
} = require("../services/user.service");
const { sendLoginEmail, sendOtpEmail } = require("../services/email.service");
const { updateUserById } = require("../models/user.model");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, otpHash, otpExpiresAt, otpAttempts, ...safeUser } = user;
  return safeUser;
}

function signToken(user) {
  const payload = {
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
    name: user.name,
  };

  return jwt.sign(payload, getJwtSecret(), { expiresIn: "7d" });
}

function validateCredentials(email, password) {
  if (!email || !password) {
    throw createHttpError(400, "Email and password are required");
  }
}

function getOtpSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

function buildOtpHash(otp) {
  return crypto.createHmac("sha256", getOtpSecret()).update(String(otp)).digest("hex");
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function setOtpForUser(userId) {
  const otp = generateOtp();
  const otpHash = buildOtpHash(otp);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await updateUserById(userId, {
    otpHash,
    otpExpiresAt: expiresAt,
    otpAttempts: 0,
  });
  return { otp, expiresAt };
}

async function register(req, res) {
  const body = await parseBody(req);
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const phone = (body.phone || "").toString().trim();

  if (!name) {
    throw createHttpError(400, "Name is required");
  }
  validateCredentials(email, password);
  if (password.length < 6) {
    throw createHttpError(400, "Password must be at least 6 characters");
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    throw createHttpError(409, "Email already in use");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const plan = buildPlan("free");
  const user = await createUser({
    name,
    email,
    passwordHash,
    phone: phone || null,
    role: "user",
    emailVerified: false,
    ...plan,
  });

  const { otp } = await setOtpForUser(user._id);
  sendJson(res, 201, {
    ok: true,
    requiresVerification: true,
    email,
    user: sanitizeUser(user),
  });

  if (user?.email) {
    setImmediate(() => {
      sendOtpEmail({ to: user.email, name: user.name, otp }).catch((err) => {
        console.error("OTP email failed:", err?.message || err);
      });
    });
  }
}

async function login(req, res) {
  const body = await parseBody(req);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  validateCredentials(email, password);

  let user = await findUserByEmail(email);
  if (!user) {
    throw createHttpError(401, "Invalid credentials");
  }

  user = await ensureUserPlan(user);

  if (!user.passwordHash) {
    throw createHttpError(401, "Invalid credentials");
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    throw createHttpError(401, "Invalid credentials");
  }

  if (!user.emailVerified) {
    const { otp } = await setOtpForUser(user._id);
    setImmediate(() => {
      sendOtpEmail({ to: user.email, name: user.name, otp }).catch((err) => {
        console.error("OTP email failed:", err?.message || err);
      });
    });
    throw createHttpError(403, "Email not verified. OTP sent.");
  }

  const token = signToken(user);
  sendJson(res, 200, { ok: true, token, user: sanitizeUser(user) });

  if (user?.email) {
    setImmediate(() => {
      sendLoginEmail({ to: user.email, name: user.name }).catch((err) => {
        console.error("Login email failed:", err?.message || err);
      });
    });
  }
}

async function adminLogin(req, res) {
  const body = await parseBody(req);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  validateCredentials(email, password);

  let user = await findUserByEmail(email);
  if (!user || user.role !== "admin") {
    throw createHttpError(401, "Invalid admin credentials");
  }

  user = await ensureUserPlan(user);

  if (!user.passwordHash) {
    throw createHttpError(401, "Invalid admin credentials");
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    throw createHttpError(401, "Invalid admin credentials");
  }

  if (!user.emailVerified) {
    const { otp } = await setOtpForUser(user._id);
    setImmediate(() => {
      sendOtpEmail({ to: user.email, name: user.name || "Admin", otp }).catch((err) => {
        console.error("OTP email failed:", err?.message || err);
      });
    });
    throw createHttpError(403, "Email not verified. OTP sent.");
  }

  const token = signToken(user);
  sendJson(res, 200, { ok: true, token, user: sanitizeUser(user) });

  if (user?.email) {
    setImmediate(() => {
      sendLoginEmail({ to: user.email, name: user.name || "Admin" }).catch((err) => {
        console.error("Admin login email failed:", err?.message || err);
      });
    });
  }
}

async function me(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const user = await findUserById(userId);
  if (!user) {
    throw createHttpError(404, "User not found");
  }

  sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
}

async function verifyOtp(req, res) {
  const body = await parseBody(req);
  const email = (body.email || "").trim().toLowerCase();
  const otp = (body.otp || "").trim();

  if (!email || !otp) {
    throw createHttpError(400, "Email and OTP are required");
  }

  const user = await findUserByEmail(email);
  if (!user) {
    throw createHttpError(404, "User not found");
  }

  if (user.emailVerified) {
    const token = signToken(user);
    sendJson(res, 200, { ok: true, token, user: sanitizeUser(user) });
    return;
  }

  const expiresAt = user.otpExpiresAt ? new Date(user.otpExpiresAt).getTime() : 0;
  if (!user.otpHash || !expiresAt || Number.isNaN(expiresAt) || Date.now() > expiresAt) {
    throw createHttpError(400, "OTP expired. Please login again to resend.");
  }

  const expected = user.otpHash;
  const actual = buildOtpHash(otp);
  if (expected !== actual) {
    const attempts = Number(user.otpAttempts || 0) + 1;
    await updateUserById(user._id, { otpAttempts: attempts });
    throw createHttpError(400, "Invalid OTP");
  }

  await updateUserById(user._id, {
    emailVerified: true,
    otpHash: null,
    otpExpiresAt: null,
    otpAttempts: 0,
  });

  const token = signToken(user);
  sendJson(res, 200, {
    ok: true,
    token,
    user: sanitizeUser({ ...user, emailVerified: true }),
  });
}

module.exports = {
  register,
  login,
  adminLogin,
  me,
  verifyOtp,
};
