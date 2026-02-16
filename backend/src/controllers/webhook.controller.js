const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { saveWebhookEvent } = require("../services/webhook.service");
const { getStrategyByKey } = require("../services/strategy.service");
const {
  sendTelegramMessage,
  getActiveSubscribersForUser,
} = require("../services/telegram.service");
const { findUserById, isPlanActive } = require("../services/user.service");

function sanitizeHeaders(headers) {
  const blocked = new Set(["authorization", "cookie"]);
  const clean = {};

  Object.entries(headers || {}).forEach(([key, value]) => {
    if (!blocked.has(key.toLowerCase())) {
      clean[key] = value;
    }
  });

  return clean;
}

function getToken(req) {
  const headerToken = req.headers["x-webhook-token"];
  const queryToken = req.parsedUrl
    ? req.parsedUrl.searchParams.get("token")
    : null;

  return headerToken || queryToken || null;
}

function getStrategyKey(req) {
  const headerKey = req.headers["x-strategy-key"];
  const queryKey = req.parsedUrl
    ? req.parsedUrl.searchParams.get("key")
    : null;
  return headerKey || queryKey || null;
}

async function chartinkWebhook(req, res) {
  if (req.method !== "POST") {
    throw createHttpError(405, "Method Not Allowed");
  }

  const expectedToken = process.env.CHARTINK_WEBHOOK_TOKEN;
  if (expectedToken) {
    const providedToken = getToken(req);
    if (providedToken !== expectedToken) {
      throw createHttpError(401, "Unauthorized");
    }
  }

  const strategyKey = getStrategyKey(req);
  if (!strategyKey) {
    throw createHttpError(400, "Strategy key is required");
  }

  const strategy = await getStrategyByKey(strategyKey);
  if (!strategy) {
    throw createHttpError(404, "Strategy not found");
  }

  const payload = await parseBody(req);
  const receivedAt = new Date().toISOString();

  const event = {
    id: crypto.randomUUID(),
    provider: "chartink",
    receivedAt,
    userId: strategy.userId.toString(),
    strategyId: strategy._id.toString(),
    strategyName: strategy.name,
    headers: sanitizeHeaders(req.headers),
    payload,
  };

  await saveWebhookEvent(event);

  const recipients = new Set();
  if (strategy.telegramEnabled && strategy.telegramChatId) {
    recipients.add(String(strategy.telegramChatId));
  }

  const owner = await findUserById(strategy.userId.toString());
  if (owner && isPlanActive(owner)) {
    const subscribers = await getActiveSubscribersForUser(strategy.userId.toString());
    subscribers.forEach((sub) => {
      if (sub?.chatId) recipients.add(String(sub.chatId));
    });
  }

  if (recipients.size > 0) {
    const tasks = Array.from(recipients).map((chatId) =>
      sendTelegramMessage(chatId, {
        strategyName: strategy.name,
        payload,
        receivedAt,
      }).catch(() => {})
    );
    await Promise.allSettled(tasks);
  }

  sendJson(res, 200, {
    ok: true,
    id: event.id,
    receivedAt: event.receivedAt,
  });
}

module.exports = { chartinkWebhook };
