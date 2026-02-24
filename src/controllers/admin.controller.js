const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { getDb } = require("../config/db");
const { buildPlan, buildPlanWithDuration } = require("../services/user.service");
const { listTokens } = require("../models/telegramToken.model");
const {
  listActiveSubscribers,
  deactivateSubscriber,
} = require("../models/telegramSubscriber.model");
const {
  sendTelegramText,
  getActiveSubscribers,
} = require("../services/telegram.service");
const { getPollingStatus } = require("../services/telegramPolling.service");
const { updateUserById } = require("../models/user.model");
const {
  createPlan,
  listPlans,
  findPlanById,
  findPlanByName,
} = require("../models/plan.model");
const { listAllStrategies, findStrategiesByUser } = require("../models/strategy.model");
const { listAlerts } = require("../services/alert.service");
const {
  listPlanRequests,
  listPlanRequestsByStatus,
  findPlanRequestById,
  updatePlanRequestStatus,
} = require("../models/planRequest.model");

async function listUsers(req, res) {
  const users = await getDb()
    .collection("users")
    .find()
    .project({ passwordHash: 0 })
    .toArray();
  sendJson(res, 200, { ok: true, users });
}

async function updatePlan(req, res) {
  const body = await parseBody(req);
  const userId = body.userId;
  const planId = body.planId;
  const planName = body.planName;
  const days = body.days ? Number(body.days) : undefined;

  if (!userId) {
    throw createHttpError(400, "userId is required");
  }

  let planData;

  if (planId) {
    const plan = await findPlanById(planId);
    if (!plan) {
      throw createHttpError(404, "Plan not found");
    }
    const duration = Number.isFinite(days) && days > 0 ? days : plan.durationDays;
    planData = buildPlanWithDuration(plan.name, duration);
  } else if (planName) {
    planData = buildPlan(planName, days);
  } else {
    throw createHttpError(400, "planId or planName is required");
  }

  const user = await updateUserById(userId, planData);
  sendJson(res, 200, { ok: true, user });
}

async function listTelegramSubscribers(req, res) {
  const subscribers = await listActiveSubscribers();
  sendJson(res, 200, { ok: true, subscribers });
}

async function deactivateTelegramSubscriber(req, res) {
  const body = await parseBody(req);
  if (!body.chatId) {
    throw createHttpError(400, "chatId is required");
  }
  const result = await deactivateSubscriber(body.chatId);
  sendJson(res, 200, { ok: true, subscriber: result });
}

async function listTelegramTokens(req, res) {
  const tokens = await listTokens(100);
  sendJson(res, 200, { ok: true, tokens });
}

async function createPlanAdmin(req, res) {
  const body = await parseBody(req);
  const name = (body.name || "").trim();
  const price = Number(body.price || 0);
  const durationDays = Number(body.durationDays || 0);

  if (!name) {
    throw createHttpError(400, "name is required");
  }
  if (!Number.isFinite(durationDays) || durationDays < 1) {
    throw createHttpError(400, "durationDays is required");
  }
  if (!Number.isFinite(price) || price < 0) {
    throw createHttpError(400, "price must be a number");
  }

  const existing = await findPlanByName(name);
  if (existing) {
    throw createHttpError(409, "Plan already exists");
  }

  const plan = await createPlan({
    name,
    price,
    durationDays,
    active: body.active !== false,
  });
  sendJson(res, 201, { ok: true, plan });
}

async function listPlansAdmin(req, res) {
  const plans = await listPlans(false);
  sendJson(res, 200, { ok: true, plans });
}

async function listPlanRequestsAdmin(req, res) {
  const statusFilter = req.parsedUrl?.searchParams?.get("status");
  let requests;
  if (statusFilter && ["pending", "approved", "rejected"].includes(statusFilter)) {
    requests = await listPlanRequestsByStatus(statusFilter);
  } else {
    requests = await listPlanRequests();
  }
  sendJson(res, 200, { ok: true, requests });
}

async function updatePlanRequestAdmin(req, res) {
  const body = await parseBody(req);
  const requestId = body.requestId;
  const status = body.status;

  if (!requestId || !status) {
    throw createHttpError(400, "requestId and status are required");
  }

  if (!["approved", "rejected"].includes(status)) {
    throw createHttpError(400, "Invalid status");
  }

  const existing = await findPlanRequestById(requestId);
  if (!existing) {
    throw createHttpError(404, "Request not found");
  }
  if (existing.status !== "pending") {
    throw createHttpError(409, "Request already processed");
  }

  const updated = await updatePlanRequestStatus(requestId, status);
  if (!updated) {
    throw createHttpError(404, "Request not found");
  }

  if (status === "approved") {
    const plan = await findPlanById(updated.planId);
    if (!plan) {
      throw createHttpError(404, "Plan not found");
    }
    const planData = buildPlanWithDuration(plan.name, plan.durationDays);
    await updateUserById(updated.userId, planData);
  }

  sendJson(res, 200, { ok: true, request: updated });
}

async function sendTelegramAdminMessage(req, res) {
  const body = await parseBody(req);
  const message = (body.message || "").trim();
  const chatId = (body.chatId || "").toString().trim();
  const broadcast = body.broadcast === true;

  if (!message) {
    throw createHttpError(400, "message is required");
  }

  if (!broadcast && !chatId) {
    throw createHttpError(400, "chatId is required if broadcast is false");
  }

  if (broadcast) {
    const subscribers = await getActiveSubscribers();
    if (subscribers.length === 0) {
      throw createHttpError(400, "No active subscribers");
    }
    let sent = 0;
    const failed = [];

    for (const sub of subscribers) {
      try {
        await sendTelegramText(sub.chatId, message);
        sent += 1;
      } catch (err) {
        failed.push({ chatId: sub.chatId });
      }
    }

    sendJson(res, 200, { ok: true, sent, failed });
    return;
  }

  await sendTelegramText(chatId, message);
  sendJson(res, 200, { ok: true, sent: 1 });
}

function getTelegramDefaultWebhookUrl() {
  const explicit = (process.env.TELEGRAM_WEBHOOK_URL || "").trim();
  if (explicit) return explicit;

  const baseUrl =
    (process.env.PUBLIC_BASE_URL || "").trim() ||
    (process.env.APP_URL || "").trim() ||
    (process.env.BASE_URL || "").trim();
  if (!baseUrl) return "";

  return `${baseUrl.replace(/\/$/, "")}/api/v1/telegram/webhook`;
}

async function setTelegramWebhook(req, res) {
  const body = await parseBody(req);
  const url = (body.url || "").trim() || getTelegramDefaultWebhookUrl();
  if (!url) {
    throw createHttpError(
      400,
      "Webhook url is required. Set TELEGRAM_WEBHOOK_URL or PUBLIC_BASE_URL."
    );
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw createHttpError(500, "TELEGRAM_BOT_TOKEN is not set");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, drop_pending_updates: true }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(400, data.description || "Failed to set webhook");
  }

  sendJson(res, 200, { ok: true, result: data, defaultUrl: url });
}

async function getTelegramWebhookInfo(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw createHttpError(500, "TELEGRAM_BOT_TOKEN is not set");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getWebhookInfo`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(400, data.description || "Failed to load webhook info");
  }

  sendJson(res, 200, {
    ok: true,
    result: data,
    defaultUrl: getTelegramDefaultWebhookUrl(),
  });
}

async function getTelegramStatus(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const polling = getPollingStatus();

  if (!token) {
    sendJson(res, 200, {
      ok: true,
      tokenConfigured: false,
      polling,
      webhook: null,
      bot: null,
    });
    return;
  }

  let bot = null;
  let webhook = null;

  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = await meRes.json().catch(() => ({}));
    if (meData?.ok) {
      bot = meData.result || null;
    } else {
      bot = { error: meData?.description || "getMe failed" };
    }
  } catch (err) {
    bot = { error: err instanceof Error ? err.message : "getMe failed" };
  }

  try {
    const hookRes = await fetch(
      `https://api.telegram.org/bot${token}/getWebhookInfo`
    );
    const hookData = await hookRes.json().catch(() => ({}));
    if (hookData?.ok) {
      webhook = hookData.result || null;
    } else {
      webhook = { error: hookData?.description || "getWebhookInfo failed" };
    }
  } catch (err) {
    webhook = { error: err instanceof Error ? err.message : "getWebhookInfo failed" };
  }

  sendJson(res, 200, {
    ok: true,
    tokenConfigured: true,
    polling,
    webhook,
    bot,
  });
}

function sanitizeStrategy(strategy) {
  if (!strategy) return strategy;
  const safe = { ...strategy };
  if (safe.marketMaya && typeof safe.marketMaya === "object") {
    const { token, ...rest } = safe.marketMaya;
    safe.marketMaya = { ...rest, tokenConfigured: Boolean(token) };
  }
  return safe;
}

async function listStrategiesAdmin(req, res) {
  const userId = req.parsedUrl?.searchParams?.get("userId");
  const strategies = userId
    ? await findStrategiesByUser(userId)
    : await listAllStrategies();
  const enriched = strategies.map((item) => ({
    ...sanitizeStrategy(item),
    webhookPath: item.webhookKey
      ? `/api/v1/webhooks/chartink?key=${item.webhookKey}`
      : "/api/v1/webhooks/chartink",
  }));
  sendJson(res, 200, { ok: true, strategies: enriched });
}

async function listAlertsAdmin(req, res) {
  const params = req.parsedUrl?.searchParams;
  const userId = params ? params.get("userId") : null;
  const strategyId = params ? params.get("strategyId") : null;
  const limitRaw = params ? params.get("limit") : null;
  const limit = limitRaw ? Math.min(Number(limitRaw) || 50, 200) : 50;

  if (!userId) {
    throw createHttpError(400, "userId is required");
  }

  const alerts = await listAlerts(userId, strategyId, limit);
  sendJson(res, 200, { ok: true, alerts });
}

module.exports = {
  listUsers,
  updatePlan,
  listTelegramSubscribers,
  deactivateTelegramSubscriber,
  listTelegramTokens,
  createPlanAdmin,
  listPlansAdmin,
  listPlanRequestsAdmin,
  updatePlanRequestAdmin,
  sendTelegramAdminMessage,
  setTelegramWebhook,
  getTelegramWebhookInfo,
  getTelegramStatus,
  listStrategiesAdmin,
  listAlertsAdmin,
};
