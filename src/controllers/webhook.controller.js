const crypto = require("crypto");
const { parseBody, readBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  saveWebhookEvent,
  updateWebhookEvent,
} = require("../services/webhook.service");
const {
  insertWebhookEvent,
  findWebhookEventById,
  findRecentEventByFingerprint,
} = require("../models/webhookEvent.model");
const { findPlanById } = require("../models/plan.model");
const {
  findPlanRequestByOrderId,
  updatePlanRequestById,
} = require("../models/planRequest.model");
const { updateUserById } = require("../models/user.model");
const { getStrategyByKey } = require("../services/strategy.service");
const {
  sendTelegramMessage,
  sendTelegramText,
  getActiveSubscribersForUser,
} = require("../services/telegram.service");
const { findUserById, isPlanActive } = require("../services/user.service");
const { executeStrategyAutoTrades } = require("../services/strategyAutoTrade.service");
const { summarizeTradeResultForTelegram } = require("../services/marketMaya.service");
const { sendSignalEmail } = require("../services/email.service");

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

async function collectRecipients(strategy, ownerPlanActive) {
  const recipients = new Set();
  if (!ownerPlanActive) return recipients;
  if (!strategy?.telegramEnabled) return recipients;

  if (strategy.telegramChatId) {
    recipients.add(String(strategy.telegramChatId));
  }

  const subscribers = await getActiveSubscribersForUser(strategy.userId.toString());
  subscribers.forEach((sub) => {
    if (sub?.chatId) recipients.add(String(sub.chatId));
  });

  return recipients;
}

function isEmailAlertEnabled(strategy) {
  return strategy?.emailEnabled !== false;
}

function formatTradeSummary({ strategyName, receivedAt, tradeResult }) {
  const mode = tradeResult.execute ? "LIVE" : "DRY-RUN";
  const lines = [`TRADE: ${strategyName}`, `Mode: ${mode}`];

  if (tradeResult.skipped) {
    lines.push("Status: SKIPPED");
    if (tradeResult.error) lines.push(`Reason: ${tradeResult.error}`);
    lines.push(`Received: ${receivedAt}`);
    return lines.join("\n");
  }

  const symbols = (tradeResult.trades || [])
    .map((t) => t.symbol || t.symbolCode)
    .filter(Boolean);
  const unique = Array.from(new Set(symbols));
  const shown = unique.slice(0, 10).join(", ");
  if (shown) {
    lines.push(`Symbols: ${shown}${unique.length > 10 ? ` +${unique.length - 10} more` : ""}`);
  }

  const orderTypes = Array.from(
    new Set(
      (tradeResult.trades || [])
        .map((t) => t.orderType || t.params?.order_type || t.request?.params?.order_type)
        .filter(Boolean)
    )
  );
  if (orderTypes.length > 0) {
    lines.push(`Order Type: ${orderTypes.join(", ")}`);
  }

  lines.push(`Result: ${tradeResult.successCount} ok / ${tradeResult.failureCount} failed`);
  if (tradeResult.failureCount > 0) {
    const firstError = (tradeResult.trades || []).find((t) => !t.ok)?.error;
    if (firstError) lines.push(`Error: ${firstError}`);
  }

  const responseLines = (tradeResult.trades || [])
    .map((trade) => {
      const summary = summarizeTradeResultForTelegram(trade);
      if (!summary) return "";
      const label = trade.symbol || trade.symbolCode || "Trade";
      return `${label}: ${summary}`;
    })
    .filter(Boolean);
  if (responseLines.length > 0) {
    lines.push("Market Maya Response:");
    responseLines.slice(0, 3).forEach((line) => lines.push(line));
    if (responseLines.length > 3) {
      lines.push(`+${responseLines.length - 3} more responses`);
    }
  }

  lines.push(`Received: ${receivedAt}`);
  return lines.join("\n");
}

function summarizeSettled(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }
  const successCount = results.filter((item) => item.status === "fulfilled").length;
  const failureCount = results.length - successCount;
  return { successCount, failureCount };
}

function normalizeBaseWebhookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const directKeys = ["stocks", "symbol", "symbol_code", "alert_name", "scan_name"];
  const hasDirectSignal = directKeys.some((key) => payload[key] !== undefined);
  if (hasDirectSignal) return payload;

  const wrapped = payload.payload;
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    return wrapped;
  }

  return payload;
}

function getProviderLabel(provider) {
  return provider === "tradingview" ? "TradingView" : "Chartink";
}

function readNestedWebhookValue(payload, path) {
  const parts = String(path || "")
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);
  let current = payload;
  for (const key of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function readFirstWebhookValue(payload, keys) {
  for (const key of keys || []) {
    const value = readNestedWebhookValue(payload, key);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeSignalAction(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!raw) return "";
  const compact = raw.replace(/[_-]+/g, " ");
  if (compact === "BUY" || compact === "LONG") return "BUY";
  if (compact === "SELL" || compact === "SHORT") return "SELL";
  if (compact === "BUY EXIT" || compact === "EXIT BUY" || compact === "LONG EXIT") return "BUY EXIT";
  if (compact === "SELL EXIT" || compact === "EXIT SELL" || compact === "SHORT EXIT") return "SELL EXIT";
  if (compact === "BUY ADD" || compact === "ADD BUY") return "BUY ADD";
  if (compact === "SELL ADD" || compact === "ADD SELL") return "SELL ADD";
  if (compact === "PARTIAL BUY EXIT" || compact === "BUY PARTIAL EXIT") return "PARTIAL BUY EXIT";
  if (compact === "PARTIAL SELL EXIT" || compact === "SELL PARTIAL EXIT") return "PARTIAL SELL EXIT";
  return "";
}

function normalizeTradingViewPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const normalized = { ...payload };
  const symbol = readFirstWebhookValue(normalized, [
    "symbol",
    "ticker",
    "trading_symbol",
    "tradingsymbol",
    "stock",
  ]);
  if (symbol !== undefined) {
    if (normalized.symbol === undefined) normalized.symbol = String(symbol).trim();
    if (normalized.stocks === undefined) normalized.stocks = String(symbol).trim();
  }

  const triggerPrice = readFirstWebhookValue(normalized, [
    "trigger_price",
    "triggerPrice",
    "price",
    "close",
    "last_price",
    "lastPrice",
  ]);
  if (triggerPrice !== undefined && normalized.trigger_price === undefined) {
    normalized.trigger_price = triggerPrice;
  }

  const signalAction = normalizeSignalAction(
    readFirstWebhookValue(normalized, [
      "call_type",
      "callType",
      "action",
      "side",
      "strategy.order.action",
      "strategy.order.comment",
    ])
  );
  if (signalAction && normalized.call_type === undefined) {
    normalized.call_type = signalAction;
  }

  const alertName = readFirstWebhookValue(normalized, [
    "alert_name",
    "alertName",
    "title",
    "name",
    "message",
    "strategy.order.id",
  ]);
  if (alertName !== undefined && normalized.alert_name === undefined) {
    normalized.alert_name = String(alertName).trim();
  }

  if (normalized.scan_name === undefined && normalized.scanName === undefined) {
    normalized.scan_name = "TradingView";
  }

  const triggeredAt = readFirstWebhookValue(normalized, [
    "triggered_at",
    "triggeredAt",
    "time",
    "timestamp",
    "bar_time",
    "barTime",
  ]);
  if (triggeredAt !== undefined && normalized.triggered_at === undefined) {
    normalized.triggered_at = triggeredAt;
  }

  return normalized;
}

function normalizeWebhookPayload(payload, provider = "chartink") {
  const normalized = normalizeBaseWebhookPayload(payload);
  if (provider === "tradingview") {
    return normalizeTradingViewPayload(normalized);
  }
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function getWebhookFingerprint(strategy, payload, provider) {
  const base = stableStringify({
    provider: provider || "chartink",
    strategyId: strategy?._id?.toString ? strategy._id.toString() : String(strategy?._id || ""),
    payload,
  });
  return crypto.createHash("sha256").update(base).digest("hex");
}

function getWebhookDedupeWindowMs() {
  const raw = Number(process.env.WEBHOOK_DEDUPE_MS || 5000);
  if (!Number.isFinite(raw) || raw <= 0) return 5000;
  return Math.min(raw, 60000);
}

async function signalWebhook(provider, req, res) {
  if (req.method !== "POST") {
    throw createHttpError(405, "Method Not Allowed");
  }

  const expectedToken =
    provider === "tradingview"
      ? process.env.TRADINGVIEW_WEBHOOK_TOKEN || process.env.CHARTINK_WEBHOOK_TOKEN
      : process.env.CHARTINK_WEBHOOK_TOKEN;
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

  const rawPayload = await parseBody(req);
  const payload = normalizeWebhookPayload(rawPayload, provider);
  const receivedAt = new Date().toISOString();
  const fingerprint = getWebhookFingerprint(strategy, payload, provider);
  const duplicateSince = new Date(Date.now() - getWebhookDedupeWindowMs()).toISOString();
  const existing = await findRecentEventByFingerprint(strategy._id, fingerprint, duplicateSince);
  if (existing?.id) {
    sendJson(res, 200, {
      ok: true,
      duplicate: true,
      id: existing.id,
      receivedAt: existing.receivedAt || receivedAt,
    });
    return;
  }

  const event = {
    id: crypto.randomUUID(),
    provider,
    receivedAt,
    userId: strategy.userId.toString(),
    strategyId: strategy._id.toString(),
    strategyName: strategy.name,
    fingerprint,
    headers: sanitizeHeaders(req.headers),
    payload,
  };

  await saveWebhookEvent(event);

  sendJson(res, 200, {
    ok: true,
    id: event.id,
    receivedAt: event.receivedAt,
  });

  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const owner = await findUserById(strategy.userId.toString());
        const ownerPlanActive = owner ? isPlanActive(owner) : false;
        const recipients = await collectRecipients(strategy, ownerPlanActive);
        const ownerEmail = owner?.email ? String(owner.email) : "";
        const debug = {
          provider,
          receivedAt,
          email: {
            enabled: Boolean(ownerEmail) && isEmailAlertEnabled(strategy),
            strategyEnabled: isEmailAlertEnabled(strategy),
            planActive: Boolean(ownerPlanActive),
          },
          telegram: {
            enabled: Boolean(strategy.telegramEnabled),
            planActive: Boolean(ownerPlanActive),
            recipients: recipients.size,
          },
          marketMaya: {
            enabled: Boolean(strategy.enabled),
          },
        };

        if (ownerEmail && ownerPlanActive && isEmailAlertEnabled(strategy)) {
          const alertName =
            payload?.alert_name || payload?.alertName || payload?.scan_name || "Signal";
          const scanName = payload?.scan_name || payload?.scanName || getProviderLabel(provider);
          const stocks = payload?.stocks || payload?.symbol || payload?.symbol_code || "-";
          try {
            await sendSignalEmail({
              to: ownerEmail,
              name: owner?.name || "Trader",
              strategyName: strategy.name,
              alertName: String(alertName),
              scanName: String(scanName),
              stocks: String(stocks),
              receivedAt,
            });
            debug.email.alert = { successCount: 1, failureCount: 0 };
          } catch (err) {
            debug.email.alert = { successCount: 0, failureCount: 1 };
            debug.email.error = err instanceof Error ? err.message : "Email failed";
          }
        } else {
          debug.email.alert = { successCount: 0, failureCount: 0, skipped: true };
        }

        if (recipients.size > 0) {
          const tasks = Array.from(recipients).map((chatId) =>
            sendTelegramMessage(chatId, {
              strategyName: strategy.name,
              payload,
              receivedAt,
            })
          );
          const results = await Promise.allSettled(tasks);
          debug.telegram.alert = summarizeSettled(results);
        } else {
          debug.telegram.alert = { successCount: 0, failureCount: 0, skipped: true };
        }

        let tradeResult = null;
        if (!strategy.enabled) {
          debug.marketMaya.skipped = true;
          debug.marketMaya.reason = "Strategy disabled";
        } else {
          try {
            tradeResult = await executeStrategyAutoTrades({
              strategy,
              payload,
              receivedAt,
            });

            debug.marketMaya.execute = Boolean(tradeResult.execute);
            debug.marketMaya.ok = Boolean(tradeResult.ok);
            debug.marketMaya.skipped = Boolean(tradeResult.skipped);
            debug.marketMaya.total = Number(tradeResult.total || 0);
            debug.marketMaya.successCount = Number(tradeResult.successCount || 0);
            debug.marketMaya.failureCount = Number(tradeResult.failureCount || 0);
            if (tradeResult.error) debug.marketMaya.error = tradeResult.error;

            if (Array.isArray(tradeResult.trades)) {
              debug.marketMaya.trades = tradeResult.trades.map((trade) => ({
                symbol: trade.symbol || "",
                symbolCode: trade.symbolCode || "",
                orderType:
                  trade.orderType || trade.params?.order_type || trade.request?.params?.order_type || null,
                price: trade.price || trade.params?.price || trade.request?.params?.price || null,
                ok: Boolean(trade.ok),
                dryRun: Boolean(trade.dryRun),
                error: trade.error || null,
                params: trade.params || trade.request?.params || null,
              }));
            }
          } catch (err) {
            debug.marketMaya.skipped = true;
            debug.marketMaya.error = err instanceof Error ? err.message : "Market Maya trade failed";
          }
        }

        if (recipients.size > 0 && tradeResult) {
          const text = formatTradeSummary({
            strategyName: strategy.name,
            receivedAt,
            tradeResult,
          });
          const tasks = Array.from(recipients).map((chatId) =>
            sendTelegramText(chatId, text)
          );
          const results = await Promise.allSettled(tasks);
          debug.telegram.summary = summarizeSettled(results);
        }

        try {
          await updateWebhookEvent(event.id, {
            debug,
            processedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error("Failed to update webhook debug:", err);
        }
      })
      .catch((err) => {
        console.error("Webhook post-processing failed:", err);
      });
  });
}

async function chartinkWebhook(req, res) {
  return signalWebhook("chartink", req, res);
}

async function tradingViewWebhook(req, res) {
  return signalWebhook("tradingview", req, res);
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function razorpayWebhook(req, res) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw createHttpError(500, "Razorpay webhook secret is not configured");
  }

  const rawBody = await readBody(req);
  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  if (!safeEqual(expected, signature)) {
    throw createHttpError(400, "Invalid webhook signature");
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    throw createHttpError(400, "Invalid webhook payload");
  }

  const fallbackId =
    payload?.payload?.payment?.entity?.id ||
    payload?.payload?.payment?.entity?.order_id ||
    crypto.createHash("sha256").update(rawBody || "").digest("hex");
  const eventId = payload.id || payload.event_id || fallbackId;
  const existing = await findWebhookEventById(eventId);
  if (existing?.processedAt) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!existing) {
    await insertWebhookEvent({
      id: eventId,
      provider: "razorpay",
      receivedAt: new Date().toISOString(),
      payload,
    });
  }

  const eventType = payload.event;
  const paymentEntity = payload?.payload?.payment?.entity || {};
  const orderId = paymentEntity.order_id;
  let processed = false;

  if (eventType === "payment.captured" && orderId) {
    const request = await findPlanRequestByOrderId(orderId);
    if (request && !request.isProcessed) {
      const plan = await findPlanById(request.planId);
      if (plan) {
        const startDate = new Date();
        const endDate = new Date(
          startDate.getTime() + Number(plan.durationDays || 0) * 86400000
        );
        await updatePlanRequestById(request._id, {
          status: "active",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          isProcessed: true,
          razorpayPaymentId: paymentEntity.id || request.razorpayPaymentId || null,
        });
        await updateUserById(request.userId, {
          planName: plan.name,
          planExpiresAt: endDate.toISOString(),
        });
        processed = true;
      }
    }
  }

  if (eventType === "payment.failed" && orderId) {
    const request = await findPlanRequestByOrderId(orderId);
    if (request && !request.isProcessed) {
      await updatePlanRequestById(request._id, {
        status: "failed",
        isProcessed: true,
        razorpayPaymentId: paymentEntity.id || request.razorpayPaymentId || null,
      });
      processed = true;
    }
  }

  await updateWebhookEvent(eventId, {
    processedAt: new Date().toISOString(),
    status: eventType || "unknown",
    processed,
  });

  sendJson(res, 200, { ok: true });
}

module.exports = { chartinkWebhook, tradingViewWebhook, razorpayWebhook };
