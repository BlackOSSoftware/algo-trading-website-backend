const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  saveWebhookEvent,
  updateWebhookEvent,
} = require("../services/webhook.service");
const { getStrategyByKey } = require("../services/strategy.service");
const {
  sendTelegramMessage,
  sendTelegramText,
  getActiveSubscribersForUser,
} = require("../services/telegram.service");
const { findUserById, isPlanActive } = require("../services/user.service");
const { executeStrategyAutoTrades } = require("../services/strategyAutoTrade.service");

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

async function collectRecipients(strategy) {
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

  return recipients;
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

  lines.push(`Result: ${tradeResult.successCount} ok / ${tradeResult.failureCount} failed`);
  if (tradeResult.failureCount > 0) {
    const firstError = (tradeResult.trades || []).find((t) => !t.ok)?.error;
    if (firstError) lines.push(`Error: ${firstError}`);
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

function normalizeWebhookPayload(payload) {
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

  const rawPayload = await parseBody(req);
  const payload = normalizeWebhookPayload(rawPayload);
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

  sendJson(res, 200, {
    ok: true,
    id: event.id,
    receivedAt: event.receivedAt,
  });

  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const recipients = await collectRecipients(strategy);
        const debug = {
          provider: "chartink",
          receivedAt,
          telegram: {
            enabled: Boolean(strategy.telegramEnabled),
            recipients: recipients.size,
          },
          marketMaya: {
            enabled: Boolean(strategy.enabled),
          },
        };

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

module.exports = { chartinkWebhook };
