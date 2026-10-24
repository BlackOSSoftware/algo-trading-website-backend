const bcrypt = require("bcryptjs");
const {
  findUserByEmail,
  findUserById,
  createUser,
  updateUserById,
} = require("../models/user.model");

const PLAN_DURATIONS = {
  free: 7,
  pro: 30,
  enterprise: 365,
};

function getPlanDuration(planName) {
  return PLAN_DURATIONS[planName] || PLAN_DURATIONS.free;
}

function buildPlan(planName, daysOverride) {
  const days = daysOverride || getPlanDuration(planName);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  return { planName, planExpiresAt: expiresAt };
}

function buildPlanWithDuration(planName, durationDays) {
  const expiresAt = new Date(
    Date.now() + durationDays * 24 * 60 * 60 * 1000
  ).toISOString();
  return { planName, planExpiresAt: expiresAt };
}

function isPlanActive(user) {
  if (!user) return false;
  if (user.role === "admin" || user.role === "sharekhan") return true;
  if (!user.planExpiresAt) return false;
  return new Date(user.planExpiresAt).getTime() > Date.now();
}

async function ensureUserPlan(user) {
  if (!user) return null;
  if (user.role === "admin" || user.role === "sharekhan") return user;
  if (user.planName && user.planExpiresAt) return user;
  const plan = buildPlan("free");
  return updateUserById(user._id, plan);
}

async function ensureAdminSeed() {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  const forceReset = process.env.ADMIN_SEED_FORCE === "true";

  if (!email || !password) return null;

  const existing = await findUserByEmail(email);
  if (existing) {
    if (forceReset) {
      const passwordHash = await bcrypt.hash(password, 10);
      return updateUserById(existing._id, {
        passwordHash,
        role: "admin",
        planName: "enterprise",
        planExpiresAt: null,
        emailVerified: true,
        otpHash: null,
        otpExpiresAt: null,
        otpAttempts: 0,
      });
    }

    if (existing.role === "admin" && !existing.emailVerified) {
      return updateUserById(existing._id, {
        emailVerified: true,
        otpHash: null,
        otpExpiresAt: null,
        otpAttempts: 0,
      });
    }

    return existing;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  return createUser({
    name: "Admin",
    email,
    passwordHash,
    role: "admin",
    planName: "enterprise",
    planExpiresAt: null,
    emailVerified: true,
  });
}

async function ensureSharekhanSeed() {
  const email = (process.env.SHAREKHAN_SEED_EMAIL || "").trim().toLowerCase();
  const password = process.env.SHAREKHAN_SEED_PASSWORD;
  if (!email || !password) return null;

  const existing = await findUserByEmail(email);
  const passwordHash = await bcrypt.hash(password, 10);
  if (existing) {
    if (existing.role !== "sharekhan" || !existing.emailVerified || process.env.SHAREKHAN_SEED_FORCE === "true") {
      return updateUserById(existing._id, {
        name: "Sharekhan Operator", passwordHash, role: "sharekhan",
        planName: null, planExpiresAt: null, emailVerified: true,
        otpHash: null, otpExpiresAt: null, otpAttempts: 0,
      });
    }
    return existing;
  }
  return createUser({
    name: "Sharekhan Operator", email, passwordHash, role: "sharekhan",
    planName: null, planExpiresAt: null, emailVerified: true,
  });
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser,
  ensureAdminSeed,
  ensureSharekhanSeed,
  buildPlan,
  buildPlanWithDuration,
  ensureUserPlan,
  isPlanActive,
};
