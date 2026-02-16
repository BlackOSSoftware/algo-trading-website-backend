const crypto = require("crypto");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  createTokenRecord,
  listTokensByUser,
} = require("../models/telegramToken.model");
const { findUserById, isPlanActive } = require("../services/user.service");

function buildToken() {
  return crypto.randomBytes(16).toString("hex");
}

async function createToken(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const user = await findUserById(userId);
  if (!user || !isPlanActive(user)) {
    throw createHttpError(403, "Plan expired");
  }

  const now = new Date().toISOString();
  const expiresAt = user.planExpiresAt;

  const token = buildToken();
  const record = await createTokenRecord({
    token,
    userId,
    expiresAt,
    createdAt: now,
  });

  sendJson(res, 201, {
    ok: true,
    token: record.token,
    expiresAt: record.expiresAt,
  });
}

async function listTokens(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const tokens = await listTokensByUser(userId, 10);
  sendJson(res, 200, { ok: true, tokens });
}

module.exports = { createToken, listTokens };
