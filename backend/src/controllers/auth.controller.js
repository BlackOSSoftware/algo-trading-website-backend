const bcrypt = require("bcryptjs");
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

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
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

async function register(req, res) {
  const body = await parseBody(req);
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

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
    role: "user",
    ...plan,
  });

  const token = signToken(user);
  sendJson(res, 201, { ok: true, token, user: sanitizeUser(user) });
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

  const token = signToken(user);
  sendJson(res, 200, { ok: true, token, user: sanitizeUser(user) });
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

  const token = signToken(user);
  sendJson(res, 200, { ok: true, token, user: sanitizeUser(user) });
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

module.exports = {
  register,
  login,
  adminLogin,
  me,
};
