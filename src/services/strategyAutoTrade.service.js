const crypto = require("crypto");
const { customTrade, resolveToken } = require("./marketMaya.service");
const {
  insertMarketMayaTrade,
  countTradesByStrategyInRange,
} = require("../models/marketMayaTrade.model");

const DEFAULT_TRADE_WINDOW_START = "09:15";
const DEFAULT_TRADE_WINDOW_END = "15:30";
const TRADE_WINDOW_TIME_ZONE =
  normalizeString(process.env.TRADE_WINDOW_TIME_ZONE || process.env.APP_TIME_ZONE) ||
  "Asia/Kolkata";
const TRADE_WINDOW_TIME_ZONE_LABEL =
  TRADE_WINDOW_TIME_ZONE === "Asia/Kolkata" ? "IST" : TRADE_WINDOW_TIME_ZONE;
const ALLOWED_CALL_TYPES = new Set([
  "BUY",
  "SELL",
  "BUY EXIT",
  "SELL EXIT",
  "BUY ADD",
  "SELL ADD",
  "PARTIAL BUY EXIT",
  "PARTIAL SELL EXIT",
]);
const EXIT_CALL_TYPES = new Set([
  "BUY EXIT",
  "SELL EXIT",
  "PARTIAL BUY EXIT",
  "PARTIAL SELL EXIT",
]);
const EXIT_ONLY_PARAM_KEYS = [
  "order_type",
  "price",
  "qty_distribution",
  "qty_value",
  "target_by",
  "target",
  "sl_by",
  "sl",
  "is_trail_sl",
  "sl_move",
  "profit_move",
];
const ALLOWED_EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO", "CDS", "MCX"]);
const ALLOWED_SEGMENTS = new Set(["EQ", "FUT", "OPT"]);
const ALLOWED_CONTRACTS = new Set(["NEAR", "NEXT", "FAR"]);
const ALLOWED_EXPIRIES = new Set(["WEEKLY", "MONTHLY"]);
const ALLOWED_OPTION_TYPES = new Set(["CE", "PE"]);
const DERIVATIVE_EXCHANGES = new Set(["NFO", "BFO", "CDS", "MCX"]);
const CASH_EXCHANGES = new Set(["NSE", "BSE"]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeTradeWindowValue(value, fallback) {
  const raw = normalizeString(value);
  if (!raw) return fallback;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : fallback;
}

function normalizeTradeAction(value) {
  const raw = normalizeString(value).toUpperCase().replace(/\s+/g, " ");
  return ALLOWED_CALL_TYPES.has(raw) ? raw : "";
}

function isExitTradeAction(value) {
  return EXIT_CALL_TYPES.has(normalizeTradeAction(value));
}

function stripExitOnlyParams(params) {
  if (!isExitTradeAction(params?.call_type)) return params;
  const sanitized = { ...(params || {}) };
  EXIT_ONLY_PARAM_KEYS.forEach((key) => {
    delete sanitized[key];
  });
  return sanitized;
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

function normalizeCallType(value) {
  return normalizeTradeAction(value);
}

function splitSymbols(value) {
  const raw = normalizeString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniquePreserveOrder(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = normalizeString(value).toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
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

function normalizeExpiryDateValue(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  const direct = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (direct) return raw;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!iso) return "";
  return `${iso[3]}-${iso[2]}-${iso[1]}`;
}

function isNumericString(value) {
  return /^-?\d+(\.\d+)?$/.test(normalizeString(value));
}

function resolveDateInput(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
}

function getTimeZoneFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function getTimeZoneParts(dateInput, timeZone = TRADE_WINDOW_TIME_ZONE) {
  const date = resolveDateInput(dateInput);
  const parts = getTimeZoneFormatter(timeZone).formatToParts(date);
  const values = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  });
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function getTimeZoneOffsetMs(dateInput, timeZone = TRADE_WINDOW_TIME_ZONE) {
  const date = resolveDateInput(dateInput);
  const parts = getTimeZoneParts(date, timeZone);
  const reconstructedUtc = Date.UTC(
    parts.year,
    (parts.month || 1) - 1,
    parts.day || 1,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  return reconstructedUtc - (date.getTime() - date.getMilliseconds());
}

function zonedDateTimeToUtc(parts, timeZone = TRADE_WINDOW_TIME_ZONE) {
  const utcGuess = Date.UTC(
    parts.year,
    (parts.month || 1) - 1,
    parts.day || 1,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    parts.millisecond || 0
  );

  // Re-run once with the first computed offset so the result stays correct even
  // when the target timezone has DST transitions.
  let offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let resolved = utcGuess - offset;
  const correctedOffset = getTimeZoneOffsetMs(new Date(resolved), timeZone);
  if (correctedOffset !== offset) {
    offset = correctedOffset;
    resolved = utcGuess - offset;
  }
  return new Date(resolved);
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

  const parts = getTimeZoneParts(now, TRADE_WINDOW_TIME_ZONE);
  const nowMinutes = (parts.hour || 0) * 60 + (parts.minute || 0);

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
    reason: label
      ? `Trade window closed (${label}, ${TRADE_WINDOW_TIME_ZONE_LABEL})`
      : `Trade window closed (${TRADE_WINDOW_TIME_ZONE_LABEL})`,
  };
}

function normalizePositiveInt(value) {
  const raw = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function normalizePositiveNumber(value) {
  const raw = value === undefined || value === null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function normalizeNonNegativeNumber(value) {
  const raw = value === undefined || value === null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

function formatNumber(value) {
  return String(Number(value.toFixed(6)));
}

function normalizeBufferBy(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return "";
  if (raw === "point" || raw === "points") return "point";
  if (raw === "percentage" || raw === "percent" || raw === "%") return "percentage";
  return raw;
}

function normalizeQtyMode(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return "";
  if (raw === "fix" || raw === "fixed") return "fix";
  if (raw === "capital(%)" || raw === "capital" || raw === "capitalpercent") return "capital";
  return raw;
}

function normalizeLimitPriceSource(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return "";
  if (raw === "manual" || raw === "limit") return "fixed";
  if (raw === "chartink" || raw === "payload") return "trigger";
  if (raw === "fixed" || raw === "trigger") return raw;
  return "";
}

function readTriggerPrice(payload) {
  const raw = readFirstPayloadValue(payload, [
    "trigger_price",
    "triggerPrice",
    "entry_price",
    "entryPrice",
    "price",
    "ltp",
    "last_price",
    "lastPrice",
    "close",
    "close_price",
    "closePrice",
  ]);
  return normalizePositiveNumber(raw);
}

function applyBufferToPrice(triggerPrice, bufferValue, callType, bufferBy) {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return null;
  if (!Number.isFinite(bufferValue) || bufferValue < 0) return null;
  if (bufferValue === 0) return triggerPrice;

  const mode = normalizeBufferBy(bufferBy) || "point";
  const offset =
    mode === "percentage" ? (triggerPrice * bufferValue) / 100 : bufferValue;
  if (!Number.isFinite(offset) || offset < 0) return null;
  if (offset === 0) return triggerPrice;

  const side = toUpper(callType);
  const adjusted = side === "SELL" ? triggerPrice - offset : triggerPrice + offset;
  if (!Number.isFinite(adjusted) || adjusted <= 0) return null;
  return adjusted;
}

function computeCapitalQty({ capitalAmount, qtyPercent, stockPrice }) {
  if (!Number.isFinite(capitalAmount) || capitalAmount <= 0) return null;
  if (!Number.isFinite(qtyPercent) || qtyPercent <= 0) return null;
  if (!Number.isFinite(stockPrice) || stockPrice <= 0) return null;
  const qty = Math.floor((capitalAmount * qtyPercent / 100) / stockPrice);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return qty;
}

function getDayRangeIso(dateInput) {
  const base = resolveDateInput(dateInput);
  const parts = getTimeZoneParts(base, TRADE_WINDOW_TIME_ZONE);
  const start = zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    TRADE_WINDOW_TIME_ZONE
  );
  const nextDayStart = zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: (parts.day || 1) + 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    TRADE_WINDOW_TIME_ZONE
  );
  const end = new Date(nextDayStart.getTime() - 1);
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
    normalizeCallType(
      readFirstPayloadValue(payload, [callTypeKey, "call_type", "callType", "action", "side"])
    ) || normalizeCallType(cfg.callTypeFallback);
  const exitTrade = isExitTradeAction(callType);

  const orderType = exitTrade
    ? ""
    : toUpper(readFirstPayloadValue(payload, ["order_type", "orderType"])) ||
      toUpper(cfg.orderType);
  const limitPriceSourceConfigured = exitTrade
    ? ""
    : normalizeLimitPriceSource(
        readFirstPayloadValue(payload, ["limit_price_source", "limitPriceSource"]) ||
          cfg.limitPriceSource
      );
  const limitPriceRawCandidate = exitTrade
    ? ""
    : normalizeString(readFirstPayloadValue(payload, ["limit_price", "limitPrice"])) ||
      normalizeString(cfg.limitPrice);
  const limitPriceSource =
    limitPriceSourceConfigured || (limitPriceRawCandidate ? "fixed" : "trigger");
  const limitPriceRaw = limitPriceSource === "fixed" ? limitPriceRawCandidate : "";
  const hasLimitPrice = Boolean(limitPriceRaw);
  const limitPriceNumeric = normalizePositiveNumber(limitPriceRaw);
  const triggerPrice = readTriggerPrice(payload);
  const bufferByRaw = exitTrade || limitPriceSource !== "trigger"
    ? ""
    : readFirstPayloadValue(payload, ["buffer_by", "bufferBy"]) || cfg.bufferBy;
  const legacyBufferValueRaw = exitTrade || limitPriceSource !== "trigger"
    ? undefined
    : readFirstPayloadValue(payload, ["buffer_points", "bufferPoints"]) ?? cfg.bufferPoints;
  const bufferValueRaw = exitTrade || limitPriceSource !== "trigger"
    ? undefined
    : readFirstPayloadValue(payload, ["buffer_value", "bufferValue"]) ??
      cfg.bufferValue ??
      legacyBufferValueRaw;
  const bufferBy = normalizeBufferBy(bufferByRaw);
  const bufferValue = normalizeNonNegativeNumber(bufferValueRaw);
  const bufferActive =
    orderType === "LIMIT" && limitPriceSource === "trigger" && Boolean(bufferBy);
  const bufferedPrice = bufferActive
    ? applyBufferToPrice(triggerPrice, bufferValue, callType, bufferBy)
    : null;
  const triggerBasedPrice = bufferActive ? bufferedPrice ?? triggerPrice : triggerPrice;
  const effectivePrice =
    orderType === "LIMIT"
      ? limitPriceSource === "fixed"
        ? limitPriceNumeric
        : triggerBasedPrice ?? limitPriceNumeric
      : triggerPrice ?? limitPriceNumeric;
  const limitPriceResolved =
    orderType === "LIMIT"
      ? limitPriceSource === "fixed"
        ? limitPriceNumeric
        : triggerBasedPrice
      : null;
  const priceForLimitOrder =
    orderType === "LIMIT" && limitPriceResolved ? formatNumber(limitPriceResolved) : "";

  const qtyDistribution = exitTrade
    ? ""
    : normalizeString(readFirstPayloadValue(payload, ["qty_distribution", "qtyDistribution"])) ||
      normalizeString(cfg.qtyDistribution);
  const qtyValue = exitTrade
    ? ""
    : normalizeString(readFirstPayloadValue(payload, ["qty_value", "qtyValue"])) ||
      normalizeString(cfg.qtyValue);
  const qtyMode = normalizeQtyMode(qtyDistribution);
  const capitalAmountRaw = exitTrade
    ? undefined
    : readFirstPayloadValue(payload, ["capital_amount", "capitalAmount"]) ?? cfg.capitalAmount;
  const capitalAmount = normalizePositiveNumber(capitalAmountRaw);
  let resolvedQtyDistribution = qtyDistribution;
  let resolvedQtyValue = qtyValue;
  let buildError = "";
  if (!exitTrade && orderType === "LIMIT") {
    if (limitPriceSource === "fixed") {
      if (!hasLimitPrice || limitPriceNumeric === null) {
        buildError = "Limit price is required when fixed limit price is selected";
      }
    } else if (!triggerPrice) {
      buildError = "Chartink trigger price is required when trigger price is selected";
    } else if (bufferActive) {
      if (bufferValue === null) {
        buildError = "Trade buffer value must be zero or a positive number";
      } else if (!callType && bufferValue > 0) {
        buildError = "call_type is required for trade buffer";
      } else if (bufferValue > 0 && bufferedPrice === null) {
        buildError = "Trade buffer produced invalid price";
      }
    }
  }

  if (!exitTrade && qtyMode === "capital") {
    const qtyPercent = normalizePositiveNumber(qtyValue);
    const computedQty = computeCapitalQty({
      capitalAmount,
      qtyPercent,
      stockPrice: effectivePrice,
    });

    if (!buildError && !capitalAmount) {
      buildError = "Capital amount is required for Capital(%) qty mode";
    } else if (!buildError && !qtyPercent) {
      buildError = "Qty value must be a positive percentage for Capital(%) qty mode";
    } else if (!buildError && !effectivePrice) {
      buildError = "Trigger price is required for Capital(%) qty mode";
    } else if (!buildError && !computedQty) {
      buildError = "Computed quantity is less than 1 for Capital(%) qty mode";
    } else if (!buildError) {
      resolvedQtyDistribution = "Fix";
      resolvedQtyValue = String(computedQty);
    }
  }

  let targetBy = "";
  let target = "";
  let slBy = "";
  let sl = "";
  let trailSl = false;
  let slMove = "";
  let profitMove = "";

  if (!exitTrade) {
    targetBy =
      normalizeString(readFirstPayloadValue(payload, ["target_by", "targetBy"])) ||
      normalizeString(cfg.targetBy);
    target =
      normalizeString(readFirstPayloadValue(payload, ["target"])) ||
      normalizeString(cfg.target);
    slBy =
      normalizeString(readFirstPayloadValue(payload, ["sl_by", "slBy"])) ||
      normalizeString(cfg.slBy);
    sl =
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
    trailSl = trailSlRaw !== undefined ? isTruthy(trailSlRaw) : isTruthy(cfg.trailSl);
    slMove =
      normalizeString(readFirstPayloadValue(payload, ["sl_move", "slMove"])) ||
      normalizeString(cfg.slMove);
    profitMove =
      normalizeString(readFirstPayloadValue(payload, ["profit_move", "profitMove"])) ||
      normalizeString(cfg.profitMove);
  }

  return {
    cfg,
    buildError,
    base: {
      ...extraParams,
      exchange,
      segment,
      ...(callType ? { call_type: callType } : {}),
      ...(orderType ? { order_type: orderType } : {}),
      ...(orderType === "LIMIT" && priceForLimitOrder ? { price: priceForLimitOrder } : {}),
      ...(resolvedQtyDistribution ? { qty_distribution: resolvedQtyDistribution } : {}),
      ...(resolvedQtyValue ? { qty_value: resolvedQtyValue } : {}),
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
    normalizeExpiryDateValue(readFirstPayloadValue(payload, ["expiry_date", "expiryDate"])) ||
    normalizeExpiryDateValue(cfg.expiryDate);

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
    return { symbolCode: "", symbols: uniquePreserveOrder(splitSymbols(raw)) };
  }

  const stocksRaw = readFirstPayloadValue(payload, ["stocks", "Stocks"]);
  const symbols = uniquePreserveOrder(splitSymbols(stocksRaw));
  if (symbolMode === "stocksAll") return { symbolCode: "", symbols };
  return { symbolCode: "", symbols: symbols.length > 0 ? [symbols[0]] : [] };
}

function buildTradeParams({ strategy, payload, symbol, symbolCode }) {
  const { cfg, base, buildError } = buildBaseParams({ strategy, payload });

  let params = { ...base };
  params = applyPayloadMap(params, payload, cfg);
  params = applyDerivativeDefaults(params, payload, cfg);
  params = stripExitOnlyParams(params);

  if (symbolCode) {
    params.symbol_code = symbolCode;
    delete params.symbol;
    delete params.segment;
    delete params.contract;
    delete params.expiry;
    delete params.expiry_date;
    delete params.option_type;
    delete params.atm;
    delete params.strike_price;
  } else if (symbol) {
    params.symbol = String(symbol);
    delete params.symbol_code;
  }

  return { params, buildError };
}

function validateMinimumParams(params) {
  const exchange = toUpper(params.exchange);
  const callType = normalizeTradeAction(params.call_type);
  const symbolCode = normalizeString(params.symbol_code);
  const symbol = normalizeString(params.symbol);
  if (!exchange) return "exchange is required";
  if (!ALLOWED_EXCHANGES.has(exchange)) {
    return "exchange must be NSE, BSE, NFO, BFO, CDS, or MCX";
  }
  params.exchange = exchange;
  if (!callType) return "call_type is required";
  if (!ALLOWED_CALL_TYPES.has(callType)) {
    return "call_type must be BUY, SELL, BUY EXIT, SELL EXIT, BUY ADD, SELL ADD, PARTIAL BUY EXIT, or PARTIAL SELL EXIT";
  }
  params.call_type = callType;
  if (!symbolCode && !symbol) return "symbol or symbol_code is required";
  if (symbolCode) return null;

  const segment = toUpper(params.segment) || "EQ";
  if (!ALLOWED_SEGMENTS.has(segment)) {
    return "segment must be EQ, FUT, or OPT";
  }
  params.segment = segment;

  if (segment === "EQ" && !CASH_EXCHANGES.has(exchange)) {
    return "EQ segment supports NSE or BSE exchange";
  }
  if ((segment === "FUT" || segment === "OPT") && !DERIVATIVE_EXCHANGES.has(exchange)) {
    return "FUT and OPT segments support NFO, BFO, CDS, or MCX exchange";
  }

  if (segment === "FUT" || segment === "OPT") {
    const rawExpiryDate = normalizeString(params.expiry_date);
    const expiryDate = normalizeExpiryDateValue(rawExpiryDate);
    if (rawExpiryDate && !expiryDate) {
      return "expiry_date must be in dd-MM-yyyy format";
    }
    if (expiryDate) {
      params.expiry_date = expiryDate;
      delete params.contract;
      delete params.expiry;
    } else {
      const contract = toUpper(params.contract);
      const expiry = toUpper(params.expiry);
      if (!contract || !ALLOWED_CONTRACTS.has(contract)) {
        return "contract must be NEAR, NEXT, or FAR for derivative segments";
      }
      if (!expiry || !ALLOWED_EXPIRIES.has(expiry)) {
        return "expiry must be WEEKLY or MONTHLY for derivative segments";
      }
      if (segment === "FUT" && expiry !== "MONTHLY") {
        return "expiry must be MONTHLY for FUT segment";
      }
      params.contract = contract;
      params.expiry = expiry;
      delete params.expiry_date;
    }
  } else {
    delete params.contract;
    delete params.expiry;
    delete params.expiry_date;
  }

  if (segment === "OPT") {
    const optionType = toUpper(params.option_type);
    if (!optionType || !ALLOWED_OPTION_TYPES.has(optionType)) {
      return "option_type must be CE or PE for OPT segment";
    }
    params.option_type = optionType;

    const strikePriceRaw = normalizeString(params.strike_price);
    const atmRaw = normalizeString(params.atm);
    if (strikePriceRaw) {
      const strikePrice = normalizePositiveNumber(strikePriceRaw);
      if (!strikePrice) {
        return "strike_price must be a positive number";
      }
      params.strike_price = formatNumber(strikePrice);
      delete params.atm;
    } else if (atmRaw) {
      if (!isNumericString(atmRaw)) {
        return "atm must be a number like 0, 100, or -100";
      }
      params.atm = String(Number(atmRaw));
      delete params.strike_price;
    } else {
      return "atm or strike_price is required for OPT segment";
    }
  } else {
    delete params.option_type;
    delete params.atm;
    delete params.strike_price;
  }

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
  const tradeWindowStart = normalizeTradeWindowValue(
    cfg.tradeWindowStart,
    DEFAULT_TRADE_WINDOW_START
  );
  const tradeWindowEnd = normalizeTradeWindowValue(
    cfg.tradeWindowEnd,
    DEFAULT_TRADE_WINDOW_END
  );

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
    const built = buildTradeParams({
      strategy,
      payload,
      symbol: target.symbol,
      symbolCode: target.symbolCode,
    });
    const params = built.params;

    const minError = built.buildError || validateMinimumParams(params);
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
