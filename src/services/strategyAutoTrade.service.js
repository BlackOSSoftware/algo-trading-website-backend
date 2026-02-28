const crypto = require("crypto");
const { customTrade, resolveToken } = require("./marketMaya.service");
const {
  insertMarketMayaTrade,
  countTradesByStrategyInRange,
} = require("../models/marketMayaTrade.model");

function normalizeString(value) {
  return String(value || "").trim();
}

function parseRatioMultiplier(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  if (raw.includes(":") || raw.includes("/")) {
    const divider = raw.includes(":") ? ":" : "/";
    const [left, right] = raw.split(divider).map((item) => item.trim());
    const a = Number(left);
    const b = Number(right);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    return b / a;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function computeTargetFromRatio(slValue, ratioValue) {
  const sl = Number(normalizeString(slValue));
  if (!Number.isFinite(sl) || sl <= 0) return null;
  const multiplier = parseRatioMultiplier(ratioValue);
  if (!multiplier) return null;
  const target = sl * multiplier;
  if (!Number.isFinite(target)) return null;
  return String(Number(target.toFixed(6)));
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function readPayloadValue(payload, key) {
  if (!payload || !key) return undefined;
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return value;
}

function readFirstPayloadValue(payload, keys) {
  for (const key of keys || []) {
    const value = readPayloadValue(payload, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function toUpper(value) {
  const raw = normalizeString(value);
  return raw ? raw.toUpperCase() : "";
}

function splitSymbols(value) {
  const raw = normalizeString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampMaxSymbols(value) {
  const raw = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  return Math.max(1, Math.min(Math.floor(raw), 25));
}

function parseTimeToMinutes(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function describeTradeWindow(startRaw, endRaw) {
  if (startRaw && endRaw) return `${startRaw}-${endRaw}`;
  if (startRaw) return `from ${startRaw}`;
  if (endRaw) return `until ${endRaw}`;
  return "";
}

function isWithinTradeWindow(now, startRaw, endRaw) {
  const start = parseTimeToMinutes(startRaw);
  const end = parseTimeToMinutes(endRaw);
  if (start === null && end === null) return { allowed: true };

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let allowed = true;
  if (start !== null && end !== null) {
    if (start === end) {
      allowed = true;
    } else if (start < end) {
      allowed = nowMinutes >= start && nowMinutes <= end;
    } else {
      allowed = nowMinutes >= start || nowMinutes <= end;
    }
  } else if (start !== null) {
    allowed = nowMinutes >= start;
  } else if (end !== null) {
    allowed = nowMinutes <= end;
  }

  if (allowed) return { allowed: true };
  const label = describeTradeWindow(startRaw, endRaw);
  return {
    allowed: false,
    reason: label ? `Trade window closed (${label})` : "Trade window closed",
  };
}

function normalizePositiveInt(value) {
  const raw = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function getDayRangeIso(dateInput) {
  const base = dateInput instanceof Date && !Number.isNaN(dateInput.valueOf())
    ? dateInput
    : new Date();
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const end = new Date(base);
  end.setHours(23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function getStrategyIds(strategy) {
  const userId = strategy?.userId?.toString ? strategy.userId.toString() : String(strategy?.userId || "");
  const strategyId = strategy?._id?.toString ? strategy._id.toString() : String(strategy?._id || "");
  return { userId, strategyId };
}

function buildBaseParams({ strategy, payload }) {
  const cfg = strategy?.marketMaya && typeof strategy.marketMaya === "object" ? strategy.marketMaya : {};
  const extraParams =
    cfg.extraParams && typeof cfg.extraParams === "object" && !Array.isArray(cfg.extraParams)
      ? cfg.extraParams
      : {};

  const exchange =
    toUpper(readFirstPayloadValue(payload, ["exchange", "Exchange"])) ||
    toUpper(cfg.exchange) ||
    "NSE";

  const segment =
    toUpper(readFirstPayloadValue(payload, ["segment", "Segment"])) ||
    toUpper(cfg.segment) ||
    "EQ";

  const callTypeKey = normalizeString(cfg.callTypeKey) || "call_type";
  const callType =
    toUpper(readFirstPayloadValue(payload, [callTypeKey, "call_type", "callType", "action", "side"])) ||
    toUpper(cfg.callTypeFallback);

  const orderType =
    toUpper(readFirstPayloadValue(payload, ["order_type", "orderType"])) ||
    toUpper(cfg.orderType);
  const limitPrice =
    normalizeString(readFirstPayloadValue(payload, ["limit_price", "limitPrice"])) ||
    normalizeString(cfg.limitPrice);

  const qtyDistribution =
    normalizeString(readFirstPayloadValue(payload, ["qty_distribution", "qtyDistribution"])) ||
    normalizeString(cfg.qtyDistribution);
  const qtyValue =
    normalizeString(readFirstPayloadValue(payload, ["qty_value", "qtyValue"])) ||
    normalizeString(cfg.qtyValue);
  let targetBy =
    normalizeString(readFirstPayloadValue(payload, ["target_by", "targetBy"])) ||
    normalizeString(cfg.targetBy);
  let target =
    normalizeString(readFirstPayloadValue(payload, ["target"])) ||
    normalizeString(cfg.target);
  const slBy =
    normalizeString(readFirstPayloadValue(payload, ["sl_by", "slBy"])) ||
    normalizeString(cfg.slBy);
  const sl =
    normalizeString(readFirstPayloadValue(payload, ["sl"])) ||
    normalizeString(cfg.sl);

  if (targetBy && targetBy.toLowerCase() === "ratio") {
    const computed = computeTargetFromRatio(sl, target);
    if (computed) {
      target = computed;
      targetBy = slBy || "";
    } else {
      target = "";
      targetBy = "";
    }
  }
  const trailSlRaw = readFirstPayloadValue(payload, ["is_trail_sl", "isTrailSl", "trailSl"]);
  const trailSl = trailSlRaw !== undefined ? isTruthy(trailSlRaw) : isTruthy(cfg.trailSl);
  const slMove =
    normalizeString(readFirstPayloadValue(payload, ["sl_move", "slMove"])) ||
    normalizeString(cfg.slMove);
  const profitMove =
    normalizeString(readFirstPayloadValue(payload, ["profit_move", "profitMove"])) ||
    normalizeString(cfg.profitMove);

  return {
    cfg,
    base: {
      ...extraParams,
      exchange,
      segment,
      ...(callType ? { call_type: callType } : {}),
      ...(orderType ? { order_type: orderType } : {}),
      ...(orderType === "LIMIT" && limitPrice ? { price: limitPrice } : {}),
      ...(qtyDistribution ? { qty_distribution: qtyDistribution } : {}),
      ...(qtyValue ? { qty_value: qtyValue } : {}),
      ...(targetBy ? { target_by: targetBy } : {}),
      ...(target ? { target } : {}),
      ...(slBy ? { sl_by: slBy } : {}),
      ...(sl ? { sl } : {}),
      ...(trailSl ? { is_trail_sl: true } : {}),
      ...(slMove ? { sl_move: slMove } : {}),
      ...(profitMove ? { profit_move: profitMove } : {}),
    },
  };
}

function applyPayloadMap(params, payload, cfg) {
  const payloadMap =
    cfg.payloadMap && typeof cfg.payloadMap === "object" && !Array.isArray(cfg.payloadMap)
      ? cfg.payloadMap
      : null;
  if (!payloadMap) return params;

  const merged = { ...params };
  Object.entries(payloadMap).forEach(([paramName, payloadKey]) => {
    const key = normalizeString(payloadKey);
    if (!key) return;
    const value = readPayloadValue(payload, key);
    if (value === undefined) return;
    merged[paramName] = value;
  });

  return merged;
}

function applyDerivativeDefaults(params, payload, cfg) {
  const segment = toUpper(params.segment);
  const merged = { ...params };

  const expiryDate =
    normalizeString(readFirstPayloadValue(payload, ["expiry_date", "expiryDate"])) ||
    normalizeString(cfg.expiryDate);

  if (segment === "FUT" || segment === "OPT") {
    if (expiryDate) {
      merged.expiry_date = expiryDate;
      delete merged.contract;
      delete merged.expiry;
    } else {
      const contract =
        toUpper(readFirstPayloadValue(payload, ["contract"])) || toUpper(cfg.contract);
      const expiry = toUpper(readFirstPayloadValue(payload, ["expiry"])) || toUpper(cfg.expiry);
      if (contract) merged.contract = contract;
      if (expiry) merged.expiry = expiry;
    }
  } else {
    delete merged.contract;
    delete merged.expiry;
    delete merged.expiry_date;
  }

  if (segment === "OPT") {
    const optionType =
      toUpper(readFirstPayloadValue(payload, ["option_type", "optionType"])) ||
      toUpper(cfg.optionType);
    if (optionType) merged.option_type = optionType;

    const strikePrice =
      normalizeString(readFirstPayloadValue(payload, ["strike_price", "strikePrice"])) ||
      normalizeString(cfg.strikePrice);
    const atm =
      normalizeString(readFirstPayloadValue(payload, ["atm"])) || normalizeString(cfg.atm);

    if (strikePrice) {
      merged.strike_price = strikePrice;
      delete merged.atm;
    } else if (atm) {
      merged.atm = atm;
      delete merged.strike_price;
    }
  } else {
    delete merged.option_type;
    delete merged.atm;
    delete merged.strike_price;
  }

  return merged;
}

function extractSymbolsFromPayload(payload, cfg) {
  const symbolCode = normalizeString(readFirstPayloadValue(payload, ["symbol_code", "symbolCode"]));
  if (symbolCode) {
    return { symbolCode, symbols: [] };
  }

  const symbolMode = normalizeString(cfg.symbolMode) || "stocksFirst";
  const symbolKey = normalizeString(cfg.symbolKey) || "symbol";

  if (symbolMode === "payloadSymbol") {
    const raw = readFirstPayloadValue(payload, [symbolKey, "symbol", "Symbol"]);
    return { symbolCode: "", symbols: splitSymbols(raw).map((s) => s.toUpperCase()) };
  }

  const stocksRaw = readFirstPayloadValue(payload, ["stocks", "Stocks"]);
  const symbols = splitSymbols(stocksRaw).map((s) => s.toUpperCase());
  if (symbolMode === "stocksAll") return { symbolCode: "", symbols };
  return { symbolCode: "", symbols: symbols.length > 0 ? [symbols[0]] : [] };
}

function buildTradeParams({ strategy, payload, symbol, symbolCode }) {
  const { cfg, base } = buildBaseParams({ strategy, payload });

  let params = { ...base };
  params = applyPayloadMap(params, payload, cfg);
  params = applyDerivativeDefaults(params, payload, cfg);

  if (symbolCode) {
    params.symbol_code = symbolCode;
    delete params.symbol;
  } else if (symbol) {
    params.symbol = String(symbol);
    delete params.symbol_code;
  }

  return params;
}

function validateMinimumParams(params) {
  const exchange = normalizeString(params.exchange);
  const callType = normalizeString(params.call_type);
  const symbolCode = normalizeString(params.symbol_code);
  const symbol = normalizeString(params.symbol);
  if (!exchange) return "exchange is required";
  if (!callType) return "call_type is required";
  if (!symbolCode && !symbol) return "symbol or symbol_code is required";
  return null;
}

async function executeStrategyAutoTrades({ strategy, payload, receivedAt }) {
  const cfg = strategy?.marketMaya && typeof strategy.marketMaya === "object" ? strategy.marketMaya : {};
  const execute = Boolean(strategy?.enabled) && !Boolean(cfg.dryRun);
  const baseUrl = normalizeString(strategy?.marketMayaUrl);
  const token = resolveToken(cfg.token);
  if (!token) {
    return {
      ok: false,
      skipped: true,
      execute,
      error: "Market Maya token is not configured (strategy or env)",
    };
  }

  const maxSymbols = clampMaxSymbols(cfg.maxSymbols);
  const dailyTradeLimit = normalizePositiveInt(cfg.dailyTradeLimit);
  const tradeWindowStart = normalizeString(cfg.tradeWindowStart);
  const tradeWindowEnd = normalizeString(cfg.tradeWindowEnd);

  if (tradeWindowStart || tradeWindowEnd) {
    const baseDate = receivedAt ? new Date(receivedAt) : new Date();
    const windowCheck = isWithinTradeWindow(baseDate, tradeWindowStart, tradeWindowEnd);
    if (!windowCheck.allowed) {
      return {
        ok: false,
        skipped: true,
        execute,
        error: windowCheck.reason || "Trade window closed",
        total: 0,
        successCount: 0,
        failureCount: 0,
        trades: [],
      };
    }
  }

  const { userId, strategyId } = getStrategyIds(strategy);
  let remainingTrades = null;
  if (dailyTradeLimit && execute) {
    const baseDate = receivedAt ? new Date(receivedAt) : new Date();
    const { startIso, endIso } = getDayRangeIso(baseDate);
    const usedCount = await countTradesByStrategyInRange(strategyId, startIso, endIso, true);
    remainingTrades = Math.max(dailyTradeLimit - usedCount, 0);
    if (remainingTrades <= 0) {
      return {
        ok: false,
        skipped: true,
        execute,
        error: `Daily trade limit reached (${dailyTradeLimit})`,
        total: 0,
        successCount: 0,
        failureCount: 0,
        trades: [],
      };
    }
  }

  const { symbolCode, symbols } = extractSymbolsFromPayload(payload, cfg);
  const targets = symbolCode ? [{ symbolCode }] : symbols.slice(0, maxSymbols).map((s) => ({ symbol: s }));
  const limitedTargets =
    remainingTrades === null ? targets : targets.slice(0, Math.max(0, remainingTrades));

  if (limitedTargets.length === 0) {
    return {
      ok: false,
      skipped: true,
      execute,
      error: "No symbol found in webhook payload (symbol/symbol_code/stocks)",
    };
  }

  const trades = [];
  const now = new Date().toISOString();

  for (const target of limitedTargets) {
    const params = buildTradeParams({
      strategy,
      payload,
      symbol: target.symbol,
      symbolCode: target.symbolCode,
    });

    const minError = validateMinimumParams(params);
    if (minError) {
      const error = `Auto trade skipped: ${minError}`;
      const entry = {
        ok: false,
        dryRun: !execute,
        error,
        symbol: target.symbol || "",
        symbolCode: target.symbolCode || "",
        params,
      };
      trades.push(entry);
      await insertMarketMayaTrade({
        id: crypto.randomUUID(),
        userId,
        strategyId,
        strategyName: strategy?.name || "",
        receivedAt: receivedAt || now,
        createdAt: now,
        execute,
        symbol: target.symbol || "",
        symbolCode: target.symbolCode || "",
        params,
        response: entry,
        ok: false,
        error,
      });
      continue;
    }

    const result = await customTrade({ token, params, execute, baseUrl });
    trades.push({
      symbol: target.symbol || "",
      symbolCode: target.symbolCode || "",
      params,
      ...result,
    });

    await insertMarketMayaTrade({
      id: crypto.randomUUID(),
      userId,
      strategyId,
      strategyName: strategy?.name || "",
      receivedAt: receivedAt || now,
      createdAt: now,
      execute,
      symbol: target.symbol || "",
      symbolCode: target.symbolCode || "",
      params,
      response: result,
      ok: Boolean(result.ok),
      error: result.ok ? null : result.error || "Market Maya request failed",
    });
  }

  const successCount = trades.filter((t) => t && t.ok).length;
  const failureCount = trades.length - successCount;

  return {
    ok: failureCount === 0,
    skipped: false,
    execute,
    total: trades.length,
    successCount,
    failureCount,
    trades,
  };
}

module.exports = {
  executeStrategyAutoTrades,
};
