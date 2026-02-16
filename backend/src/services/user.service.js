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
  if (user.role === "admin") return true;
  if (!user.planExpiresAt) return false;
  return new Date(user.planExpiresAt).getTime() > Date.now();
}

async function ensureUserPlan(user) {
  if (!user) return null;
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
  });
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser,
  ensureAdminSeed,
  buildPlan,
  buildPlanWithDuration,
  ensureUserPlan,
  isPlanActive,
};
