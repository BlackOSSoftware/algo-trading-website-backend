const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { createStrategy, listStrategies } = require("../services/strategy.service");

function normalizeUrl(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  return trimmed;
}

async function create(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const name = (body.name || "").trim();
  const webhookUrl = normalizeUrl(body.webhookUrl);
  const marketMayaUrl = normalizeUrl(body.marketMayaUrl);
  const enabled = Boolean(body.enabled);
  const telegramEnabled = Boolean(body.telegramEnabled);

  if (!name) {
    throw createHttpError(400, "Strategy name is required");
  }

  if (!webhookUrl) {
    throw createHttpError(400, "Webhook URL is required");
  }

  if (enabled && !marketMayaUrl) {
    throw createHttpError(400, "Market Maya URL is required when enabled");
  }

  // Telegram chat ID is managed via bot subscription tokens; do not require it here.

  const now = new Date().toISOString();
  const webhookKey = crypto.randomBytes(16).toString("hex");
  const strategy = await createStrategy({
    userId,
    name,
    webhookUrl,
    marketMayaUrl: enabled ? marketMayaUrl : "",
    enabled,
    webhookKey,
    telegramEnabled,
    telegramChatId: "",
    createdAt: now,
    updatedAt: now,
  });

  sendJson(res, 201, {
    ok: true,
    strategy: {
      ...strategy,
      webhookPath: `/api/v1/webhooks/chartink?key=${webhookKey}`,
    },
  });
}

async function list(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const strategies = await listStrategies(userId);
  const enriched = strategies.map((item) => ({
    ...item,
    webhookPath: `/api/v1/webhooks/chartink?key=${item.webhookKey}`,
  }));
  sendJson(res, 200, { ok: true, strategies: enriched });
}

module.exports = {
  create,
  list,
};
