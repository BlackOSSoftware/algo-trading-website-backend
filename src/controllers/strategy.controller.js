const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { normalizeClockTime } = require("../utils/clockTime");
const {
  createStrategy,
  listStrategies,
  getStrategyByKey,
  getStrategyByIdForUser,
  updateStrategy,
  deleteStrategy,
} = require("../services/strategy.service");

const DEFAULT_TRADE_WINDOW_START = "09:15";
const DEFAULT_TRADE_WINDOW_END = "15:30";
const ALLOWED_CALL_TYPE_FALLBACKS = new Set([
  "BUY",
  "SELL",
  "BUY EXIT",
  "SELL EXIT",
  "BUY ADD",
  "SELL ADD",
  "PARTIAL BUY EXIT",
  "PARTIAL SELL EXIT",
]);
const ALLOWED_MARKET_MAYA_EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO", "CDS", "MCX"]);
const ALLOWED_MARKET_MAYA_SEGMENTS = new Set(["EQ", "FUT", "OPT"]);
const ALLOWED_SYMBOL_MODES = new Set([
  "stocksFirst",
  "stocksAll",
  "payloadSymbol",
  "manualList",
]);
const ALLOWED_MARKET_MAYA_CONTRACTS = new Set(["NEAR", "NEXT", "FAR"]);
const ALLOWED_MARKET_MAYA_EXPIRIES = new Set(["WEEKLY", "MONTHLY"]);
const ALLOWED_MARKET_MAYA_OPTION_TYPES = new Set(["CE", "PE"]);
const ALLOWED_LIMIT_PRICE_SOURCES = new Set(["fixed", "trigger", "mstockHigh", "mstockLow"]);
const ALLOWED_MSTOCK_API_TYPES = new Set(["typeA", "typeB"]);
const ALLOWED_MSTOCK_INTERVALS = new Set([
  "minute",
  "3minute",
  "5minute",
  "10minute",
  "15minute",
  "30minute",
  "60minute",
  "day",
]);

function normalizeUrl(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  return trimmed;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeBoolean(value, defaultValue = false) {
  return value === undefined ? defaultValue : Boolean(value);
}

function normalizeStoredTime(value, fallback) {
  return normalizeClockTime(value, fallback);
}

function normalizeTradeAction(value) {
  return normalizeString(value).toUpperCase().replace(/\s+/g, " ");
}

function normalizeExpiryDate(value, label) {
  const raw = normalizeString(value);
  if (!raw) return "";
  const direct = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (direct) return raw;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  throw createHttpError(400, `${label} must be in dd-MM-yyyy format`);
}

function isNumericText(value) {
  return /^-?\d+(\.\d+)?$/.test(normalizeString(value));
}

function normalizePositiveInt(value) {
  const numeric = value === undefined || value === null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function normalizeMStockApiType(value) {
  const compact = normalizeString(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compact || compact === "typea" || compact === "a") return compact ? "typeA" : "";
  if (compact === "typeb" || compact === "b") return "typeB";
  throw createHttpError(400, "marketMaya.mStockApiType must be Type A or Type B");
}

function normalizeMStockInterval(value) {
  const compact = normalizeString(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compact) return "";
  if (
    compact === "minute" ||
    compact === "1minute" ||
    compact === "1m" ||
    compact === "oneminute"
  ) {
    return "minute";
  }
  if (compact === "3minute" || compact === "3m" || compact === "threeminute") {
    return "3minute";
  }
  if (compact === "5minute" || compact === "5m" || compact === "fiveminute") {
    return "5minute";
  }
  if (compact === "10minute" || compact === "10m" || compact === "tenminute") {
    return "10minute";
  }
  if (compact === "15minute" || compact === "15m" || compact === "fifteenminute") {
    return "15minute";
  }
  if (compact === "30minute" || compact === "30m" || compact === "thirtyminute") {
    return "30minute";
  }
  if (
    compact === "60minute" ||
    compact === "60m" ||
    compact === "1hour" ||
    compact === "onehour"
  ) {
    return "60minute";
  }
  if (compact === "day" || compact === "1day" || compact === "oneday") {
    return "day";
  }
  throw createHttpError(
    400,
    "marketMaya.mStockInterval must be minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute, or day"
  );
}

function buildDefaultTradeWindowConfig() {
  return {
    tradeWindowStart: DEFAULT_TRADE_WINDOW_START,
    tradeWindowEnd: DEFAULT_TRADE_WINDOW_END,
  };
}

function normalizeClearList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => normalizeString(item)).filter(Boolean);
      }
    } catch {
      // fall back to comma splitting
    }
    return trimmed
      .split(",")
      .map((item) => normalizeString(item))
      .filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, flag]) => Boolean(flag))
      .map(([key]) => normalizeString(key))
      .filter(Boolean);
  }
  return [];
}

function normalizeSymbolList(value) {
  const rawValues = Array.isArray(value) ? value : normalizeString(value).split(",");
  const seen = new Set();
  const symbols = [];
  for (const item of rawValues) {
    const symbol = normalizeString(item).toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

function normalizeSymbolMode(value, fallback = "") {
  const compact = normalizeString(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compact) return fallback;
  if (compact === "stocksfirst" || compact === "firststock" || compact === "firststocks") {
    return "stocksFirst";
  }
  if (compact === "stocksall" || compact === "allstocks") {
    return "stocksAll";
  }
  if (
    compact === "payloadsymbol" ||
    compact === "payloadsymbols" ||
    compact === "symbolfield" ||
    compact === "customsymbol"
  ) {
    return "payloadSymbol";
  }
  if (
    compact === "manuallist" ||
    compact === "manualstocks" ||
    compact === "manualstocklist" ||
    compact === "fixedstocks" ||
    compact === "fixedstockslist" ||
    compact === "stocklist" ||
    compact === "whitelist"
  ) {
    return "manualList";
  }
  return fallback;
}

function normalizeTime(value, label) {
  const raw = normalizeString(value);
  if (!raw) return "";
  const normalized = normalizeClockTime(raw);
  if (!normalized) {
    throw createHttpError(400, `${label} must be in HH:mm (24h)`);
  }
  return normalized;
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

function normalizeLimitPriceSource(value, limitPrice) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return limitPrice ? "fixed" : "";
  if (raw === "manual" || raw === "limit") return "fixed";
  if (raw === "chartink" || raw === "payload") return "trigger";
  if (raw === "mstock" || raw === "mstockhigh" || raw === "mstockcandlehigh") {
    return "mstockHigh";
  }
  if (raw === "mstocklow" || raw === "mstockcandlelow") {
    return "mstockLow";
  }
  if (!ALLOWED_LIMIT_PRICE_SOURCES.has(raw)) {
    throw createHttpError(
      400,
      "marketMaya.limitPriceSource must be fixed, trigger, mstockHigh, or mstockLow"
    );
  }
  return raw;
}

function normalizeMarketMayaConfig(value) {
  if (!value || typeof value !== "object") return null;

  const exchange = normalizeString(value.exchange).toUpperCase();
  const segment = normalizeString(value.segment).toUpperCase();
  if (exchange && !ALLOWED_MARKET_MAYA_EXCHANGES.has(exchange)) {
    throw createHttpError(
      400,
      "marketMaya.exchange must be NSE, BSE, NFO, BFO, CDS, or MCX"
    );
  }
  if (segment && !ALLOWED_MARKET_MAYA_SEGMENTS.has(segment)) {
    throw createHttpError(400, "marketMaya.segment must be EQ, FUT, or OPT");
  }

  const token = normalizeString(value.token);
  const symbols = normalizeSymbolList(
    value.symbols ??
      value.stockList ??
      value.stock_list ??
      value.fixedStocks ??
      value.fixed_stocks
  );
  const resolvedSymbolMode =
    normalizeSymbolMode(
      value.symbolMode ?? value.symbol_mode ?? value.symbolSource ?? value.symbol_source
    ) || (symbols.length > 0 ? "manualList" : "stocksFirst");
  if (!ALLOWED_SYMBOL_MODES.has(resolvedSymbolMode)) {
    throw createHttpError(
      400,
      "marketMaya.symbolMode must be stocksFirst, stocksAll, manualList, or payloadSymbol"
    );
  }
  const symbolMode = resolvedSymbolMode;
  const symbolKey = normalizeString(value.symbolKey) || "symbol";
  const callTypeKey = normalizeString(value.callTypeKey) || "call_type";
  const callTypeFallback = normalizeTradeAction(value.callTypeFallback);
  if (callTypeFallback && !ALLOWED_CALL_TYPE_FALLBACKS.has(callTypeFallback)) {
    throw createHttpError(
      400,
      "marketMaya.callTypeFallback must be BUY, SELL, BUY EXIT, SELL EXIT, BUY ADD, SELL ADD, PARTIAL BUY EXIT, or PARTIAL SELL EXIT"
    );
  }
  const orderType = normalizeString(value.orderType || value.order_type).toUpperCase();
  const limitPrice = normalizeString(value.limitPrice || value.limit_price);
  const limitPriceSource = normalizeLimitPriceSource(
    value.limitPriceSource ?? value.limit_price_source ?? value.priceSource ?? value.price_source,
    limitPrice
  );
  const explicitMStockApiType = normalizeMStockApiType(
    value.mStockApiType ?? value.mstockApiType ?? value.mstock_api_type
  );
  const explicitMStockApiKey = normalizeString(
    value.mStockApiKey ?? value.mstockApiKey ?? value.mstock_api_key
  );
  const explicitMStockAuthToken = normalizeString(
    value.mStockAuthToken ?? value.mstockAuthToken ?? value.mstock_auth_token
  );
  const explicitMStockExchange = normalizeString(
    value.mStockExchange ?? value.mstockExchange ?? value.mstock_exchange
  ).toUpperCase();
  const explicitMStockInstrumentToken = normalizeString(
    value.mStockInstrumentToken ??
      value.mstockInstrumentToken ??
      value.mstock_instrument_token ??
      value.mStockSymbolToken ??
      value.mstockSymbolToken ??
      value.mstock_symbol_token
  );
  const explicitMStockInterval = normalizeMStockInterval(
    value.mStockInterval ?? value.mstockInterval ?? value.mstock_interval
  );
  const explicitMStockCandleOffset = normalizePositiveInt(
    value.mStockCandleOffset ?? value.mstockCandleOffset ?? value.mstock_candle_offset
  );
  const mStockApiType =
    explicitMStockApiType || normalizeMStockApiType(process.env.MSTOCK_API_TYPE);
  const mStockApiKey = explicitMStockApiKey || normalizeString(process.env.MSTOCK_API_KEY);
  const mStockAuthToken =
    explicitMStockAuthToken || normalizeString(process.env.MSTOCK_AUTH_TOKEN);
  const mStockExchange =
    explicitMStockExchange || normalizeString(process.env.MSTOCK_EXCHANGE).toUpperCase();
  const mStockInstrumentToken =
    explicitMStockInstrumentToken || normalizeString(process.env.MSTOCK_INSTRUMENT_TOKEN);
  const mStockInterval =
    explicitMStockInterval || normalizeMStockInterval(process.env.MSTOCK_INTERVAL);
  const mStockCandleOffset =
    explicitMStockCandleOffset ?? normalizePositiveInt(process.env.MSTOCK_CANDLE_OFFSET);
  const bufferBy = normalizeString(value.bufferBy || value.buffer_by);
  const bufferValueRaw =
    value.bufferValue ??
    value.buffer_value ??
    value.bufferPoints ??
    value.buffer_points;
  const bufferValue = bufferValueRaw !== undefined ? Number(bufferValueRaw) : undefined;
  const capitalAmountRaw = value.capitalAmount ?? value.capital_amount;
  const capitalAmount = capitalAmountRaw !== undefined ? Number(capitalAmountRaw) : undefined;

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
      value.start_time ??
      DEFAULT_TRADE_WINDOW_START,
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
      value.end_time ??
      DEFAULT_TRADE_WINDOW_END,
    "marketMaya.tradeWindowEnd"
  );

  const contract = normalizeString(value.contract).toUpperCase();
  if (contract && !ALLOWED_MARKET_MAYA_CONTRACTS.has(contract)) {
    throw createHttpError(400, "marketMaya.contract must be NEAR, NEXT, or FAR");
  }
  const expiry = normalizeString(value.expiry).toUpperCase();
  if (expiry && !ALLOWED_MARKET_MAYA_EXPIRIES.has(expiry)) {
    throw createHttpError(400, "marketMaya.expiry must be WEEKLY or MONTHLY");
  }
  if (segment === "FUT" && expiry && expiry !== "MONTHLY") {
    throw createHttpError(400, "marketMaya.expiry must be MONTHLY for FUT segment");
  }
  const expiryDate = normalizeExpiryDate(
    value.expiryDate || value.expiry_date,
    "marketMaya.expiryDate"
  );
  const optionType = normalizeString(value.optionType || value.option_type).toUpperCase();
  if (optionType && !ALLOWED_MARKET_MAYA_OPTION_TYPES.has(optionType)) {
    throw createHttpError(400, "marketMaya.optionType must be CE or PE");
  }
  const atm = normalizeString(value.atm);
  if (atm && !isNumericText(atm)) {
    throw createHttpError(400, "marketMaya.atm must be a numeric value like 0, 100, or -100");
  }
  const strikePrice = normalizeString(value.strikePrice || value.strike_price);
  if (strikePrice) {
    const strikeNumber = Number(strikePrice);
    if (!Number.isFinite(strikeNumber) || strikeNumber <= 0) {
      throw createHttpError(400, "marketMaya.strikePrice must be a positive number");
    }
  }
  if (orderType === "LIMIT" && limitPriceSource === "fixed" && !limitPrice) {
    throw createHttpError(
      400,
      "marketMaya.limitPrice is required when marketMaya.limitPriceSource is fixed"
    );
  }
  if (limitPriceSource === "mstockHigh" || limitPriceSource === "mstockLow") {
    if (!mStockApiType || !ALLOWED_MSTOCK_API_TYPES.has(mStockApiType)) {
      throw createHttpError(400, "marketMaya.mStockApiType is required for mStock candle price");
    }
    if (!mStockApiKey) {
      throw createHttpError(400, "marketMaya.mStockApiKey is required for mStock candle price");
    }
    if (!mStockAuthToken) {
      throw createHttpError(
        400,
        "marketMaya.mStockAuthToken is required for mStock candle price"
      );
    }
    if (!mStockExchange) {
      throw createHttpError(400, "marketMaya.mStockExchange is required for mStock candle price");
    }
    if (!mStockInstrumentToken) {
      throw createHttpError(
        400,
        "marketMaya.mStockInstrumentToken is required for mStock candle price"
      );
    }
    if (!mStockInterval || !ALLOWED_MSTOCK_INTERVALS.has(mStockInterval)) {
      throw createHttpError(400, "marketMaya.mStockInterval is required for mStock candle price");
    }
  }
  if (symbolMode === "manualList" && symbols.length === 0) {
    throw createHttpError(
      400,
      "marketMaya.symbols must include at least one stock when marketMaya.symbolMode is manualList"
    );
  }

  const maxSymbolsRaw = value.maxSymbols;
  const maxSymbols = maxSymbolsRaw !== undefined ? Number(maxSymbolsRaw) : undefined;
  const dryRun = Boolean(value.dryRun);
  const dailyTradeLimitRaw =
    value.dailyTradeLimit ?? value.daily_trade_limit ?? value.tradeLimit ?? value.trade_limit;
  const dailyTradeLimit =
    dailyTradeLimitRaw !== undefined ? Number(dailyTradeLimitRaw) : undefined;

  const extraParams = parseJsonObject(value.extraParams, "marketMaya.extraParams");
  const payloadMap = parseJsonObject(value.payloadMap, "marketMaya.payloadMap");
  const derivativeSegment = segment === "FUT" || segment === "OPT";
  const optionSegment = segment === "OPT";
  const derivativeConfig = derivativeSegment
    ? expiryDate
      ? { expiryDate }
      : {
          ...(contract ? { contract } : {}),
          ...(expiry ? { expiry } : {}),
        }
    : {};
  const optionConfig = optionSegment
    ? {
        ...(optionType ? { optionType } : {}),
        ...(strikePrice ? { strikePrice } : atm ? { atm } : {}),
      }
    : {};

  return {
    ...(token ? { token } : {}),
    ...(exchange ? { exchange } : {}),
    ...(segment ? { segment } : {}),
    symbolMode,
    symbolKey,
    ...(symbols.length ? { symbols } : {}),
    callTypeKey,
    callTypeFallback,
    ...derivativeConfig,
    ...optionConfig,
    ...(orderType ? { orderType } : {}),
    ...(limitPriceSource ? { limitPriceSource } : {}),
    ...(limitPrice ? { limitPrice } : {}),
    ...(explicitMStockApiType ? { mStockApiType: explicitMStockApiType } : {}),
    ...(explicitMStockApiKey ? { mStockApiKey: explicitMStockApiKey } : {}),
    ...(explicitMStockAuthToken ? { mStockAuthToken: explicitMStockAuthToken } : {}),
    ...(explicitMStockExchange ? { mStockExchange: explicitMStockExchange } : {}),
    ...(explicitMStockInstrumentToken
      ? { mStockInstrumentToken: explicitMStockInstrumentToken }
      : {}),
    ...(explicitMStockInterval ? { mStockInterval: explicitMStockInterval } : {}),
    ...(explicitMStockCandleOffset ? { mStockCandleOffset: explicitMStockCandleOffset } : {}),
    ...(bufferBy ? { bufferBy } : {}),
    ...(Number.isFinite(bufferValue) && bufferValue >= 0 ? { bufferValue } : {}),
    ...(Number.isFinite(capitalAmount) && capitalAmount > 0 ? { capitalAmount } : {}),
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
  const marketMayaSource =
    safe.marketMaya && typeof safe.marketMaya === "object" ? safe.marketMaya : {};
  const { token, ...rest } = marketMayaSource;
  safe.marketMaya = {
    ...buildDefaultTradeWindowConfig(),
    ...rest,
    ...(token ? { token } : {}),
    tradeWindowStart: normalizeStoredTime(rest.tradeWindowStart, DEFAULT_TRADE_WINDOW_START),
    tradeWindowEnd: normalizeStoredTime(rest.tradeWindowEnd, DEFAULT_TRADE_WINDOW_END),
    tokenConfigured: Boolean(token),
  };
  return safe;
}

function buildWebhookPath(webhookKey) {
  const key = typeof webhookKey === "string" ? webhookKey.trim() : "";
  return key ? `/api/v1/webhooks/chartink?key=${key}` : "/api/v1/webhooks/chartink";
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
  const emailEnabled = normalizeBoolean(body.emailEnabled, true);
  const telegramEnabled = Boolean(body.telegramEnabled);
  const marketMaya = normalizeMarketMayaConfig(body.marketMaya);
  const marketMayaConfig = marketMaya || buildDefaultTradeWindowConfig();
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
      ...marketMayaConfig,
      ...(marketMayaToken ? { token: marketMayaToken } : {}),
    },
    webhookKey,
    emailEnabled,
    telegramEnabled,
    telegramChatId: "",
    createdAt: now,
    updatedAt: now,
  });

  sendJson(res, 201, {
    ok: true,
    strategy: {
      ...sanitizeStrategy(strategy),
      webhookPath: buildWebhookPath(webhookKey),
    },
  });
}

async function list(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const strategies = await listStrategies(userId);
  const source = Array.isArray(strategies) ? strategies : [];
  const enriched = source
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      ...sanitizeStrategy(item),
      webhookPath: buildWebhookPath(item.webhookKey),
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
  const marketMayaConfig = marketMaya || buildDefaultTradeWindowConfig();
  const marketMayaToken = normalizeString(body.marketMayaToken);
  const marketMayaClear = normalizeClearList(
    body.marketMayaClear ?? body.market_maya_clear ?? body.marketMaya_clear
  );

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
  const emailEnabled = normalizeBoolean(body.emailEnabled, existing.emailEnabled !== false);

  const tokenAfter =
    marketMayaToken ||
    marketMayaConfig?.token ||
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
    emailEnabled,
    telegramEnabled,
    updatedAt: now,
  };

  Object.entries(marketMayaConfig).forEach(([key, value]) => {
    patch[`marketMaya.${key}`] = value;
  });
  if (marketMayaToken) {
    patch["marketMaya.token"] = marketMayaToken;
  }

  const unset = {};
  if (marketMayaClear.length) {
    const setKeys = new Set();
    if (marketMaya) {
      Object.keys(marketMaya).forEach((key) => setKeys.add(key));
    }
    if (marketMayaToken) {
      setKeys.add("token");
    }
    marketMayaClear.forEach((key) => {
      if (!key || key === "token" || setKeys.has(key)) return;
      unset[`marketMaya.${key}`] = "";
    });
  }

  const unsetPayload = Object.keys(unset).length ? unset : undefined;

  let updated = await updateStrategy(userId, strategyId, patch, unsetPayload);
  if (!updated && webhookKey) {
    const byKey = await getStrategyByKey(webhookKey);
    if (byKey && byKey.userId?.toString && byKey.userId.toString() === String(userId)) {
      updated = await updateStrategy(userId, byKey._id, patch, unsetPayload);
    }
  }
  if (!updated) {
    throw createHttpError(404, "Strategy not found");
  }

  const safeUpdated = sanitizeStrategy(updated) || {};
  const resolvedWebhookKey = normalizeString(
    updated?.webhookKey || existing?.webhookKey || webhookKey
  );

  sendJson(res, 200, {
    ok: true,
    strategy: {
      ...safeUpdated,
      webhookPath: buildWebhookPath(resolvedWebhookKey),
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
