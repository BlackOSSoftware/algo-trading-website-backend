const crypto = require("crypto");
const { customTrade, resolveToken } = require("./marketMaya.service");
const { insertMarketMayaTrade } = require("../models/marketMayaTrade.model");

function normalizeString(value) {
  return String(value || "").trim();
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
  const targetBy =
    normalizeString(readFirstPayloadValue(payload, ["target_by", "targetBy"])) ||
    normalizeString(cfg.targetBy);
  const target =
    normalizeString(readFirstPayloadValue(payload, ["target"])) ||
    normalizeString(cfg.target);
  const slBy =
    normalizeString(readFirstPayloadValue(payload, ["sl_by", "slBy"])) ||
    normalizeString(cfg.slBy);
  const sl =
    normalizeString(readFirstPayloadValue(payload, ["sl"])) ||
    normalizeString(cfg.sl);
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

  const { symbolCode, symbols } = extractSymbolsFromPayload(payload, cfg);
  const targets = symbolCode ? [{ symbolCode }] : symbols.slice(0, maxSymbols).map((s) => ({ symbol: s }));

  if (targets.length === 0) {
    return {
      ok: false,
      skipped: true,
      execute,
      error: "No symbol found in webhook payload (symbol/symbol_code/stocks)",
    };
  }

  const trades = [];
  const now = new Date().toISOString();
  const { userId, strategyId } = getStrategyIds(strategy);

  for (const target of targets) {
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
