const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  createStrategy,
  listStrategies,
  getStrategyByKey,
  getStrategyByIdForUser,
  updateStrategy,
  deleteStrategy,
} = require("../services/strategy.service");

function normalizeUrl(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  return trimmed;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeTime(value, label) {
  const raw = normalizeString(value);
  if (!raw) return "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
    throw createHttpError(400, `${label} must be in HH:mm (24h)`);
  }
  return raw;
}

function parseJsonObject(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") {
    throw createHttpError(400, `${label} must be an object or JSON string`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed;
  } catch {
    throw createHttpError(400, `${label} must be a valid JSON object`);
  }
}

function normalizeMarketMayaConfig(value) {
  if (!value || typeof value !== "object") return null;

  const exchange = normalizeString(value.exchange).toUpperCase();
  const segment = normalizeString(value.segment).toUpperCase();

  const token = normalizeString(value.token);
  const symbolMode = normalizeString(value.symbolMode) || "stocksFirst";
  const symbolKey = normalizeString(value.symbolKey) || "symbol";
  const callTypeKey = normalizeString(value.callTypeKey) || "call_type";
  const callTypeFallback = normalizeString(value.callTypeFallback).toUpperCase() || "BUY";
  const orderType = normalizeString(value.orderType || value.order_type).toUpperCase();
  const limitPrice = normalizeString(value.limitPrice || value.limit_price);

  const qtyDistribution = normalizeString(value.qtyDistribution || value.qty_distribution);
  const qtyValue = normalizeString(value.qtyValue || value.qty_value);
  const targetBy = normalizeString(value.targetBy || value.target_by);
  const target = normalizeString(value.target);
  const slBy = normalizeString(value.slBy || value.sl_by);
  const sl = normalizeString(value.sl);
  const trailSlRaw = value.trailSl ?? value.isTrailSl ?? value.is_trail_sl;
  const trailSl = Boolean(trailSlRaw);
  const slMove = normalizeString(value.slMove || value.sl_move);
  const profitMove = normalizeString(value.profitMove || value.profit_move);
  const tradeWindowStart = normalizeTime(
    value.tradeWindowStart ??
      value.trade_window_start ??
      value.tradeStart ??
      value.trade_start ??
      value.tradeStartTime ??
      value.trade_start_time ??
      value.startTime ??
      value.start_time,
    "marketMaya.tradeWindowStart"
  );
  const tradeWindowEnd = normalizeTime(
    value.tradeWindowEnd ??
      value.trade_window_end ??
      value.tradeEnd ??
      value.trade_end ??
      value.tradeEndTime ??
      value.trade_end_time ??
      value.endTime ??
      value.end_time,
    "marketMaya.tradeWindowEnd"
  );

  const contract = normalizeString(value.contract).toUpperCase();
  const expiry = normalizeString(value.expiry).toUpperCase();
  const expiryDate = normalizeString(value.expiryDate || value.expiry_date);
  const optionType = normalizeString(value.optionType || value.option_type).toUpperCase();
  const atm = normalizeString(value.atm);
  const strikePrice = normalizeString(value.strikePrice || value.strike_price);

  const maxSymbolsRaw = value.maxSymbols;
  const maxSymbols = maxSymbolsRaw !== undefined ? Number(maxSymbolsRaw) : undefined;
  const dryRun = Boolean(value.dryRun);
  const dailyTradeLimitRaw =
    value.dailyTradeLimit ?? value.daily_trade_limit ?? value.tradeLimit ?? value.trade_limit;
  const dailyTradeLimit =
    dailyTradeLimitRaw !== undefined ? Number(dailyTradeLimitRaw) : undefined;

  const extraParams = parseJsonObject(value.extraParams, "marketMaya.extraParams");
  const payloadMap = parseJsonObject(value.payloadMap, "marketMaya.payloadMap");

  return {
    ...(token ? { token } : {}),
    ...(exchange ? { exchange } : {}),
    ...(segment ? { segment } : {}),
    symbolMode,
    symbolKey,
    callTypeKey,
    callTypeFallback,
    ...(contract ? { contract } : {}),
    ...(expiry ? { expiry } : {}),
    ...(expiryDate ? { expiryDate } : {}),
    ...(optionType ? { optionType } : {}),
    ...(atm ? { atm } : {}),
    ...(strikePrice ? { strikePrice } : {}),
    ...(orderType ? { orderType } : {}),
    ...(limitPrice ? { limitPrice } : {}),
    ...(qtyDistribution ? { qtyDistribution } : {}),
    ...(qtyValue ? { qtyValue } : {}),
    ...(targetBy ? { targetBy } : {}),
    ...(target ? { target } : {}),
    ...(slBy ? { slBy } : {}),
    ...(sl ? { sl } : {}),
    ...(trailSl ? { trailSl } : {}),
    ...(slMove ? { slMove } : {}),
    ...(profitMove ? { profitMove } : {}),
    ...(tradeWindowStart ? { tradeWindowStart } : {}),
    ...(tradeWindowEnd ? { tradeWindowEnd } : {}),
    ...(Number.isFinite(dailyTradeLimit) && dailyTradeLimit > 0
      ? { dailyTradeLimit: Math.floor(dailyTradeLimit) }
      : {}),
    ...(Number.isFinite(maxSymbols) ? { maxSymbols } : {}),
    ...(dryRun ? { dryRun } : {}),
    ...(extraParams ? { extraParams } : {}),
    ...(payloadMap ? { payloadMap } : {}),
  };
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
  const marketMaya = normalizeMarketMayaConfig(body.marketMaya);
  const marketMayaTokenRaw = body.marketMayaToken;
  const marketMayaToken = normalizeString(marketMayaTokenRaw);

  if (!name) {
    throw createHttpError(400, "Strategy name is required");
  }

  if (!webhookUrl) {
    throw createHttpError(400, "Webhook URL is required");
  }

  const hasToken = Boolean(marketMayaToken || marketMaya?.token || process.env.MARKETMAYA_TOKEN);
  if (enabled && !hasToken) {
    throw createHttpError(400, "Market Maya token is required when enabled");
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
    marketMaya: {
      ...(marketMaya || {}),
      ...(marketMayaToken ? { token: marketMayaToken } : {}),
    },
    webhookKey,
    telegramEnabled,
    telegramChatId: "",
    createdAt: now,
    updatedAt: now,
  });

  sendJson(res, 201, {
    ok: true,
    strategy: {
      ...sanitizeStrategy(strategy),
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
    ...sanitizeStrategy(item),
    webhookPath: `/api/v1/webhooks/chartink?key=${item.webhookKey}`,
  }));
  sendJson(res, 200, { ok: true, strategies: enriched });
}

async function update(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const strategyId = String(body.strategyId || body._id || body.id || "").trim();
  const webhookKey = normalizeString(body.webhookKey || body.webhook_key);

  const name = (body.name || "").trim();
  const marketMayaUrl = normalizeUrl(body.marketMayaUrl);
  const enabled = Boolean(body.enabled);
  const telegramEnabled = Boolean(body.telegramEnabled);
  const marketMaya = normalizeMarketMayaConfig(body.marketMaya);
  const marketMayaToken = normalizeString(body.marketMayaToken);

  if (!strategyId) {
    throw createHttpError(400, "strategyId is required");
  }

  if (!name) {
    throw createHttpError(400, "Strategy name is required");
  }

  const existing = await getStrategyByIdForUser(userId, strategyId);
  if (!existing) {
    throw createHttpError(404, "Strategy not found");
  }

  const tokenAfter =
    marketMayaToken ||
    marketMaya?.token ||
    existing.marketMaya?.token ||
    process.env.MARKETMAYA_TOKEN;
  if (enabled && !tokenAfter) {
    throw createHttpError(400, "Market Maya token is required when enabled");
  }

  const now = new Date().toISOString();

  const patch = {
    name,
    marketMayaUrl: enabled ? marketMayaUrl : "",
    enabled,
    telegramEnabled,
    updatedAt: now,
  };

  if (marketMaya) {
    Object.entries(marketMaya).forEach(([key, value]) => {
      patch[`marketMaya.${key}`] = value;
    });
  }
  if (marketMayaToken) {
    patch["marketMaya.token"] = marketMayaToken;
  }

  let updated = await updateStrategy(userId, strategyId, patch);
  if (!updated && webhookKey) {
    const byKey = await getStrategyByKey(webhookKey);
    if (byKey && byKey.userId?.toString && byKey.userId.toString() === String(userId)) {
      updated = await updateStrategy(userId, byKey._id, patch);
    }
  }
  if (!updated) {
    throw createHttpError(404, "Strategy not found");
  }

  sendJson(res, 200, {
    ok: true,
    strategy: {
      ...sanitizeStrategy(updated),
      webhookPath: updated.webhookKey
        ? `/api/v1/webhooks/chartink?key=${updated.webhookKey}`
        : "/api/v1/webhooks/chartink",
    },
  });
}

async function remove(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const strategyId = String(body.strategyId || body._id || body.id || "").trim();
  if (!strategyId) {
    throw createHttpError(400, "strategyId is required");
  }

  const deleted = await deleteStrategy(userId, strategyId);
  if (!deleted) {
    throw createHttpError(404, "Strategy not found");
  }

  sendJson(res, 200, { ok: true });
}

module.exports = {
  create,
  list,
  update,
  remove,
};
