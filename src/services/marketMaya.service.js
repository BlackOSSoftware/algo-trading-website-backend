const DEFAULT_BASE_URL = "https://restapi.marketmaya.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CALL_TYPE_MAP = {
  buy: "BUY",
  sell: "SELL",
  "buy exit": "BUY EXIT",
  "sell exit": "SELL EXIT",
  "buy add": "BUY ADD",
  "sell add": "SELL ADD",
  "partial buy exit": "PARTIAL BUY EXIT",
  "partial sell exit": "PARTIAL SELL EXIT",
};
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
const CASH_EXCHANGES = new Set(["NSE", "BSE"]);
const DERIVATIVE_EXCHANGES = new Set(["NFO", "BFO", "CDS", "MCX"]);

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function resolveBaseUrl(override) {
  const normalizedOverride = normalizeBaseUrl(override);
  if (normalizedOverride) return normalizedOverride;
  const normalizedEnv = normalizeBaseUrl(process.env.MARKETMAYA_BASE_URL);
  return normalizedEnv || DEFAULT_BASE_URL;
}

function getUserAgent() {
  const fromEnv = String(process.env.MARKETMAYA_USER_AGENT || "").trim();
  return fromEnv || DEFAULT_USER_AGENT;
}

function redactSensitiveText(text) {
  return String(text || "")
    .replace(/([?&]token=)([^&\s"'<]+)/gi, "$1[REDACTED]")
    .replace(/(["'\s])token([=:]\s*)([^\s"'&<>]{8,})/gi, "$1token$2[REDACTED]");
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toSafeSnippet(text, max = 260) {
  const raw = normalizeWhitespace(redactSensitiveText(text));
  if (!raw) return "";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 3)}...`;
}

function looksLikeHtml(payload, contentType) {
  if (String(contentType || "").toLowerCase().includes("text/html")) return true;
  if (typeof payload !== "string") return false;
  const sample = payload.slice(0, 400).toLowerCase();
  return sample.includes("<!doctype html") || sample.includes("<html");
}

function isCloudflareChallenge(payload, contentType) {
  if (!looksLikeHtml(payload, contentType)) return false;
  if (typeof payload !== "string") return false;
  const normalized = payload.toLowerCase();
  return (
    normalized.includes("just a moment") ||
    normalized.includes("cloudflare") ||
    normalized.includes("cf-chl") ||
    normalized.includes("cf-ray")
  );
}

function extractChallengeRayId(payload, headers) {
  const fromHeader = String(headers?.cfRay || "").trim();
  if (fromHeader) return fromHeader;
  if (typeof payload !== "string") return "";
  const match = /cf-ray[:\s]*([a-z0-9-]+)/i.exec(payload);
  return match ? String(match[1] || "").trim() : "";
}


function normalizeToken(value) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

function resolveToken(token) {
  return normalizeToken(token) || normalizeToken(process.env.MARKETMAYA_TOKEN);
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function normalizeMode(value, map) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  return map[raw.toLowerCase()] || "";
}

function normalizeCallType(value) {
  return normalizeMode(value, CALL_TYPE_MAP);
}

function stripExitOnlyParams(params) {
  if (!EXIT_CALL_TYPES.has(String(params?.call_type || "").trim().toUpperCase())) return params;
  const sanitized = { ...(params || {}) };
  EXIT_ONLY_PARAM_KEYS.forEach((key) => {
    delete sanitized[key];
  });
  return sanitized;
}

function parsePositiveNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function isNumericString(value) {
  return /^-?\d+(\.\d+)?$/.test(String(value || "").trim());
}

function normalizeExpiryDateValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (direct) return raw;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!iso) return "";
  return `${iso[3]}-${iso[2]}-${iso[1]}`;
}

function formatNumber(value) {
  return String(Number(value.toFixed(6)));
}

function normalizeAndValidateTradeParams(inputParams) {
  const params = { ...(inputParams || {}) };

  const callTypeMode = normalizeCallType(params.call_type);
  if (params.call_type !== undefined && !callTypeMode) {
    return {
      ok: false,
      error:
        "Invalid call_type. Use BUY, SELL, BUY EXIT, SELL EXIT, BUY ADD, SELL ADD, PARTIAL BUY EXIT, or PARTIAL SELL EXIT.",
    };
  }
  if (callTypeMode) params.call_type = callTypeMode;
  const sanitizedParams = stripExitOnlyParams(params);
  const isExitTrade = EXIT_CALL_TYPES.has(callTypeMode);

  const exchange = String(sanitizedParams.exchange || "").trim().toUpperCase();
  if (!exchange) {
    return { ok: false, error: "exchange is required." };
  }
  if (!ALLOWED_EXCHANGES.has(exchange)) {
    return { ok: false, error: "exchange must be NSE, BSE, NFO, BFO, CDS, or MCX." };
  }
  sanitizedParams.exchange = exchange;

  const symbolCode = String(sanitizedParams.symbol_code || "").trim();
  if (symbolCode) {
    sanitizedParams.symbol_code = symbolCode;
    delete sanitizedParams.segment;
    delete sanitizedParams.symbol;
    delete sanitizedParams.contract;
    delete sanitizedParams.expiry;
    delete sanitizedParams.expiry_date;
    delete sanitizedParams.option_type;
    delete sanitizedParams.atm;
    delete sanitizedParams.strike_price;
  } else {
    const segment = String(sanitizedParams.segment || "").trim().toUpperCase();
    if (!segment) {
      return { ok: false, error: "segment is required when symbol_code is not provided." };
    }
    if (!ALLOWED_SEGMENTS.has(segment)) {
      return { ok: false, error: "segment must be EQ, FUT, or OPT." };
    }
    sanitizedParams.segment = segment;

    const symbol = String(sanitizedParams.symbol || "").trim().toUpperCase();
    if (!symbol) {
      return { ok: false, error: "symbol is required when symbol_code is not provided." };
    }
    sanitizedParams.symbol = symbol;

    if (segment === "EQ" && !CASH_EXCHANGES.has(exchange)) {
      return { ok: false, error: "EQ segment supports NSE or BSE exchange only." };
    }
    if ((segment === "FUT" || segment === "OPT") && !DERIVATIVE_EXCHANGES.has(exchange)) {
      return {
        ok: false,
        error: "FUT and OPT segments support NFO, BFO, CDS, or MCX exchange only.",
      };
    }

    if (segment === "FUT" || segment === "OPT") {
      const expiryDate = normalizeExpiryDateValue(sanitizedParams.expiry_date);
      if (String(sanitizedParams.expiry_date || "").trim() && !expiryDate) {
        return { ok: false, error: "expiry_date must be in dd-MM-yyyy format." };
      }
      if (expiryDate) {
        sanitizedParams.expiry_date = expiryDate;
        delete sanitizedParams.contract;
        delete sanitizedParams.expiry;
      } else {
        const contract = String(sanitizedParams.contract || "").trim().toUpperCase();
        const expiry = String(sanitizedParams.expiry || "").trim().toUpperCase();
        if (!contract || !ALLOWED_CONTRACTS.has(contract)) {
          return {
            ok: false,
            error: "contract must be NEAR, NEXT, or FAR for derivative segments.",
          };
        }
        if (!expiry || !ALLOWED_EXPIRIES.has(expiry)) {
          return {
            ok: false,
            error: "expiry must be WEEKLY or MONTHLY for derivative segments.",
          };
        }
        if (segment === "FUT" && expiry !== "MONTHLY") {
          return { ok: false, error: "expiry must be MONTHLY for FUT segment." };
        }
        sanitizedParams.contract = contract;
        sanitizedParams.expiry = expiry;
        delete sanitizedParams.expiry_date;
      }
    } else {
      delete sanitizedParams.contract;
      delete sanitizedParams.expiry;
      delete sanitizedParams.expiry_date;
    }

    if (segment === "OPT") {
      const optionType = String(sanitizedParams.option_type || "").trim().toUpperCase();
      if (!optionType || !ALLOWED_OPTION_TYPES.has(optionType)) {
        return { ok: false, error: "option_type must be CE or PE for OPT segment." };
      }
      sanitizedParams.option_type = optionType;

      const strikePriceRaw = String(sanitizedParams.strike_price || "").trim();
      const atmRaw = String(sanitizedParams.atm || "").trim();
      if (strikePriceRaw) {
        const strikePrice = parsePositiveNumber(strikePriceRaw);
        if (!strikePrice) {
          return { ok: false, error: "strike_price must be a positive number." };
        }
        sanitizedParams.strike_price = formatNumber(strikePrice);
        delete sanitizedParams.atm;
      } else if (atmRaw) {
        if (!isNumericString(atmRaw)) {
          return { ok: false, error: "atm must be a number like 0, 100, or -100." };
        }
        sanitizedParams.atm = String(Number(atmRaw));
        delete sanitizedParams.strike_price;
      } else {
        return { ok: false, error: "atm or strike_price is required for OPT segment." };
      }
    } else {
      delete sanitizedParams.option_type;
      delete sanitizedParams.atm;
      delete sanitizedParams.strike_price;
    }
  }

  if (!isExitTrade) {
    const orderTypeMode = normalizeMode(sanitizedParams.order_type || "MARKET", {
      market: "MARKET",
      limit: "LIMIT",
    });
    if (!orderTypeMode) {
      return { ok: false, error: "Invalid order_type. Use MARKET or LIMIT." };
    }
    sanitizedParams.order_type = orderTypeMode;
  } else {
    delete sanitizedParams.order_type;
    delete sanitizedParams.price;
  }

  const qtyMode = normalizeMode(sanitizedParams.qty_distribution, {
    fix: "Fix",
    fixed: "Fix",
    "capital(%)": "Capital(%)",
    "capital %": "Capital(%)",
    capital: "Capital(%)",
    "capital risk(%)": "Capital Risk(%)",
    "capital risk %": "Capital Risk(%)",
    "capitalrisk(%)": "Capital Risk(%)",
    "capital risk": "Capital Risk(%)",
    capitalrisk: "Capital Risk(%)",
  });
  if (sanitizedParams.qty_distribution !== undefined && !qtyMode) {
    return {
      ok: false,
      error: "Invalid qty_distribution. Use Fix, Capital(%), or Capital Risk(%).",
    };
  }
  if (qtyMode) sanitizedParams.qty_distribution = qtyMode;

  const targetMode = normalizeMode(sanitizedParams.target_by, {
    money: "Money",
    point: "Point",
    points: "Point",
    percentage: "Percentage",
    percent: "Percentage",
    price: "Price",
  });
  if (sanitizedParams.target_by !== undefined && !targetMode) {
    return {
      ok: false,
      error: "Invalid target_by. Use Money, Point, Percentage, or Price.",
    };
  }
  if (targetMode) sanitizedParams.target_by = targetMode;

  const slMode = normalizeMode(sanitizedParams.sl_by, {
    money: "Money",
    point: "Point",
    points: "Point",
    percentage: "Percentage",
    percent: "Percentage",
    price: "Price",
  });
  if (sanitizedParams.sl_by !== undefined && !slMode) {
    return {
      ok: false,
      error: "Invalid sl_by. Use Money, Point, Percentage, or Price.",
    };
  }
  if (slMode) sanitizedParams.sl_by = slMode;

  const hasTargetBy = Boolean(String(sanitizedParams.target_by || "").trim());
  const hasTarget = Boolean(String(sanitizedParams.target || "").trim());
  if (hasTargetBy && !hasTarget) {
    return { ok: false, error: "target is required when target_by is set." };
  }
  if (!hasTargetBy && hasTarget) {
    return { ok: false, error: "target_by is required when target is set." };
  }
  if (hasTarget) {
    const targetValue = parsePositiveNumber(sanitizedParams.target);
    if (!targetValue) {
      return { ok: false, error: "target must be a positive number." };
    }
    sanitizedParams.target = formatNumber(targetValue);
  }

  const hasSlBy = Boolean(String(sanitizedParams.sl_by || "").trim());
  const hasSl = Boolean(String(sanitizedParams.sl || "").trim());
  if (hasSlBy && !hasSl) {
    return { ok: false, error: "sl is required when sl_by is set." };
  }
  if (!hasSlBy && hasSl) {
    return { ok: false, error: "sl_by is required when sl is set." };
  }
  if (hasSl) {
    const slValue = parsePositiveNumber(sanitizedParams.sl);
    if (!slValue) {
      return { ok: false, error: "sl must be a positive number." };
    }
    sanitizedParams.sl = formatNumber(slValue);
  }

  if (sanitizedParams.qty_distribution !== undefined || sanitizedParams.qty_value !== undefined) {
    const hasQtyDistribution = Boolean(String(sanitizedParams.qty_distribution || "").trim());
    const hasQtyValue = Boolean(String(sanitizedParams.qty_value || "").trim());
    if (hasQtyDistribution && !hasQtyValue) {
      return { ok: false, error: "qty_value is required when qty_distribution is set." };
    }
    if (!hasQtyDistribution && hasQtyValue) {
      return { ok: false, error: "qty_distribution is required when qty_value is set." };
    }
    if (hasQtyValue) {
      const qtyValue = parsePositiveNumber(sanitizedParams.qty_value);
      if (!qtyValue) {
        return { ok: false, error: "qty_value must be a positive number." };
      }
      sanitizedParams.qty_value = formatNumber(qtyValue);
    }
  }

  if (sanitizedParams.order_type === "LIMIT") {
    const priceValue = parsePositiveNumber(sanitizedParams.price);
    if (!priceValue) {
      return { ok: false, error: "price is required and must be positive for LIMIT order." };
    }
    sanitizedParams.price = formatNumber(priceValue);
  } else {
    delete sanitizedParams.price;
  }

  const trailEnabled = isTruthy(sanitizedParams.is_trail_sl);
  if (!trailEnabled) {
    delete sanitizedParams.is_trail_sl;
    delete sanitizedParams.sl_move;
    delete sanitizedParams.profit_move;
  } else {
    sanitizedParams.is_trail_sl = true;
    const slMoveValue = parsePositiveNumber(sanitizedParams.sl_move);
    const profitMoveValue = parsePositiveNumber(sanitizedParams.profit_move);
    if (!slMoveValue) {
      return { ok: false, error: "sl_move must be a positive number when trail SL is enabled." };
    }
    if (!profitMoveValue) {
      return {
        ok: false,
        error: "profit_move must be a positive number when trail SL is enabled.",
      };
    }
    sanitizedParams.sl_move = formatNumber(slMoveValue);
    sanitizedParams.profit_move = formatNumber(profitMoveValue);
  }

  return { ok: true, params: sanitizedParams };
}

function cleanParams(params) {
  const cleaned = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      cleaned[key] = trimmed;
      return;
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) return;
      cleaned[key] = String(value);
      return;
    }
    if (typeof value === "boolean") {
      if (!value) return;
      cleaned[key] = "true";
      return;
    }

    cleaned[key] = String(value);
  });
  return cleaned;
}

function buildUrl(path, token, params, baseUrlOverride) {
  const baseUrl = resolveBaseUrl(baseUrlOverride);
  const url = new URL(`${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
  url.searchParams.set("token", token);

  const cleaned = cleanParams(params);
  Object.entries(cleaned).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}

function buildPreview({ path, token, params, baseUrl }) {
  const cleaned = cleanParams(params);
  return {
    ok: true,
    dryRun: true,
    request: {
      baseUrl: resolveBaseUrl(baseUrl),
      path,
      tokenConfigured: Boolean(token),
      params: cleaned,
    },
  };
}

async function fetchMarketMayaJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": getUserAgent(),
      },
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      headers: {
        cfRay: response.headers.get("cf-ray") || "",
        server: response.headers.get("server") || "",
      },
      payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getTimeoutMs() {
  const raw = process.env.MARKETMAYA_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 60_000);
  return 15_000;
}

function extractPayloadMessage(payload, max = 260) {
  if (!payload) return "";
  if (typeof payload === "string") {
    return toSafeSnippet(payload, max);
  }
  if (typeof payload !== "object") {
    return toSafeSnippet(String(payload), max);
  }
  if (Array.isArray(payload) && payload.length === 0) {
    return "";
  }
  if (!Array.isArray(payload) && Object.keys(payload).length === 0) {
    return "";
  }

  const candidates = ["message", "status_message", "description", "detail", "msg", "error"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return toSafeSnippet(value, max);
    }
  }

  try {
    return toSafeSnippet(JSON.stringify(payload), max);
  } catch {
    return "";
  }
}

function extractErrorMessage(payload, meta = {}) {
  const contentType = meta.contentType || "";
  const headers = meta.headers || {};
  const status = meta.status;
  const server = String(headers?.server || "").trim().toLowerCase();

  if (!payload) return "Market Maya request failed";
  if (isCloudflareChallenge(payload, contentType)) {
    const rayId = extractChallengeRayId(payload, headers);
    const suffix = rayId ? ` (CF-RAY: ${rayId})` : "";
    return `Market Maya request was blocked by Cloudflare challenge${suffix}. Retry shortly or whitelist server IP.`;
  }
  if (server === "cloudflare" && typeof payload === "string") {
    const rayId = extractChallengeRayId(payload, headers);
    const snippet = toSafeSnippet(payload);
    const suffix = rayId ? ` (CF-RAY: ${rayId})` : "";
    if (snippet) {
      return `Cloudflare proxy error: ${snippet}${suffix}`;
    }
    return `Cloudflare proxy error${suffix}`;
  }
  if (looksLikeHtml(payload, contentType)) {
    return "Market Maya returned an HTML page instead of API response.";
  }
  if (typeof payload === "string") {
    const snippet = toSafeSnippet(payload);
    if (snippet) return snippet;
    return status ? `Market Maya API error (${status})` : "Market Maya request failed";
  }
  if (typeof payload !== "object") return String(payload);

  const candidates = ["message", "error", "description", "msg", "detail"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return toSafeSnippet(value);
  }

  try {
    return toSafeSnippet(JSON.stringify(payload));
  } catch {
    return "Market Maya request failed";
  }
}

async function customTrade({ token, params, execute, baseUrl }) {
  const resolvedToken = resolveToken(token);
  if (!resolvedToken) {
    return { ok: false, dryRun: true, error: "MARKETMAYA_TOKEN is not set" };
  }

  const precheck = normalizeAndValidateTradeParams(params);
  if (!precheck.ok) {
    return {
      ok: false,
      dryRun: true,
      validationError: true,
      error: `Invalid trade params: ${precheck.error}`,
    };
  }
  const safeParams = precheck.params;

  const path = "/custom-trade";
  if (!isTruthy(execute)) {
    return buildPreview({ path, token: resolvedToken, params: safeParams, baseUrl });
  }

  const url = buildUrl(path, resolvedToken, safeParams, baseUrl);
  const result = await fetchMarketMayaJson(url, getTimeoutMs());

  if (!result.ok) {
    return {
      ok: false,
      dryRun: false,
      status: result.status,
      error: `Market Maya API error (${result.status}): ${extractErrorMessage(result.payload, result)}`,
      result,
    };
  }

  return {
    ok: true,
    dryRun: false,
    result,
  };
}

async function getCallHistory({ token, execute, baseUrl }) {
  const resolvedToken = resolveToken(token);
  if (!resolvedToken) {
    return { ok: false, dryRun: true, error: "MARKETMAYA_TOKEN is not set" };
  }

  const path = "/custom-trade/getcallhistory";
  if (execute === undefined || isTruthy(execute)) {
    const url = buildUrl(path, resolvedToken, {}, baseUrl);
    const result = await fetchMarketMayaJson(url, getTimeoutMs());
    if (!result.ok) {
      return {
        ok: false,
        dryRun: false,
        status: result.status,
        error: extractErrorMessage(result.payload, result),
        result,
      };
    }
    return { ok: true, dryRun: false, result };
  }

  return buildPreview({ path, token: resolvedToken, params: {}, baseUrl });
}

async function getSymbolPosition({ token, execute, baseUrl }) {
  const resolvedToken = resolveToken(token);
  if (!resolvedToken) {
    return { ok: false, dryRun: true, error: "MARKETMAYA_TOKEN is not set" };
  }

  const path = "/custom-trade/getsymbolposition";
  if (execute === undefined || isTruthy(execute)) {
    const url = buildUrl(path, resolvedToken, {}, baseUrl);
    const result = await fetchMarketMayaJson(url, getTimeoutMs());
    if (!result.ok) {
      return {
        ok: false,
        dryRun: false,
        status: result.status,
        error: extractErrorMessage(result.payload, result),
        result,
      };
    }
    return { ok: true, dryRun: false, result };
  }

  return buildPreview({ path, token: resolvedToken, params: {}, baseUrl });
}

function summarizeTradeResultForTelegram(result, max = 180) {
  if (!result) return "";

  if (result.dryRun) {
    try {
      const params = result.request?.params || result.params || {};
      const snippet = toSafeSnippet(JSON.stringify(params), max);
      return snippet ? `Preview: ${snippet}` : "Preview ready";
    } catch {
      return "Preview ready";
    }
  }

  if (!result.ok) {
    return toSafeSnippet(result.error || "Market Maya request failed", max);
  }

  const responseMeta = result.result || {};
  const summary = extractPayloadMessage(responseMeta.payload, max);
  const status =
    Number.isFinite(Number(responseMeta.status)) && Number(responseMeta.status) > 0
      ? `HTTP ${Number(responseMeta.status)}`
      : "";

  if (status && summary) return `${status}: ${summary}`;
  if (summary) return summary;
  if (status) return `${status}: Trade placed successfully`;
  return "Trade placed successfully";
}

module.exports = {
  resolveToken,
  customTrade,
  getCallHistory,
  getSymbolPosition,
  summarizeTradeResultForTelegram,
};
