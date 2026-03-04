const DEFAULT_BASE_URL = "https://restapi.marketmaya.com";

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
  const raw = String(value || "").trim();
  if (!raw) return "";
  return map[raw.toLowerCase()] || "";
}

function parsePositiveNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function formatNumber(value) {
  return String(Number(value.toFixed(6)));
}

function normalizeAndValidateTradeParams(inputParams) {
  const params = { ...(inputParams || {}) };

  const callTypeMode = normalizeMode(params.call_type, {
    buy: "BUY",
    sell: "SELL",
  });
  if (params.call_type !== undefined && !callTypeMode) {
    return { ok: false, error: "Invalid call_type. Use BUY or SELL." };
  }
  if (callTypeMode) params.call_type = callTypeMode;

  const orderTypeMode = normalizeMode(params.order_type, {
    market: "MARKET",
    limit: "LIMIT",
  });
  if (params.order_type !== undefined && !orderTypeMode) {
    return { ok: false, error: "Invalid order_type. Use MARKET or LIMIT." };
  }
  if (orderTypeMode) params.order_type = orderTypeMode;

  const qtyMode = normalizeMode(params.qty_distribution, {
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
  if (params.qty_distribution !== undefined && !qtyMode) {
    return {
      ok: false,
      error: "Invalid qty_distribution. Use Fix, Capital(%), or Capital Risk(%).",
    };
  }
  if (qtyMode) params.qty_distribution = qtyMode;

  const targetMode = normalizeMode(params.target_by, {
    money: "Money",
    point: "Point",
    points: "Point",
    percentage: "Percentage",
    percent: "Percentage",
    price: "Price",
  });
  if (params.target_by !== undefined && !targetMode) {
    return {
      ok: false,
      error: "Invalid target_by. Use Money, Point, Percentage, or Price.",
    };
  }
  if (targetMode) params.target_by = targetMode;

  const slMode = normalizeMode(params.sl_by, {
    money: "Money",
    point: "Point",
    points: "Point",
    percentage: "Percentage",
    percent: "Percentage",
    price: "Price",
  });
  if (params.sl_by !== undefined && !slMode) {
    return {
      ok: false,
      error: "Invalid sl_by. Use Money, Point, Percentage, or Price.",
    };
  }
  if (slMode) params.sl_by = slMode;

  const hasTargetBy = Boolean(String(params.target_by || "").trim());
  const hasTarget = Boolean(String(params.target || "").trim());
  if (hasTargetBy && !hasTarget) {
    return { ok: false, error: "target is required when target_by is set." };
  }
  if (!hasTargetBy && hasTarget) {
    return { ok: false, error: "target_by is required when target is set." };
  }
  if (hasTarget) {
    const targetValue = parsePositiveNumber(params.target);
    if (!targetValue) {
      return { ok: false, error: "target must be a positive number." };
    }
    params.target = formatNumber(targetValue);
  }

  const hasSlBy = Boolean(String(params.sl_by || "").trim());
  const hasSl = Boolean(String(params.sl || "").trim());
  if (hasSlBy && !hasSl) {
    return { ok: false, error: "sl is required when sl_by is set." };
  }
  if (!hasSlBy && hasSl) {
    return { ok: false, error: "sl_by is required when sl is set." };
  }
  if (hasSl) {
    const slValue = parsePositiveNumber(params.sl);
    if (!slValue) {
      return { ok: false, error: "sl must be a positive number." };
    }
    params.sl = formatNumber(slValue);
  }

  if (params.qty_distribution !== undefined || params.qty_value !== undefined) {
    const hasQtyDistribution = Boolean(String(params.qty_distribution || "").trim());
    const hasQtyValue = Boolean(String(params.qty_value || "").trim());
    if (hasQtyDistribution && !hasQtyValue) {
      return { ok: false, error: "qty_value is required when qty_distribution is set." };
    }
    if (!hasQtyDistribution && hasQtyValue) {
      return { ok: false, error: "qty_distribution is required when qty_value is set." };
    }
    if (hasQtyValue) {
      const qtyValue = parsePositiveNumber(params.qty_value);
      if (!qtyValue) {
        return { ok: false, error: "qty_value must be a positive number." };
      }
      params.qty_value = formatNumber(qtyValue);
    }
  }

  if (params.order_type === "LIMIT") {
    const priceValue = parsePositiveNumber(params.price);
    if (!priceValue) {
      return { ok: false, error: "price is required and must be positive for LIMIT order." };
    }
    params.price = formatNumber(priceValue);
  }

  const trailEnabled = isTruthy(params.is_trail_sl);
  if (!trailEnabled) {
    delete params.is_trail_sl;
    delete params.sl_move;
    delete params.profit_move;
  } else {
    params.is_trail_sl = true;
    const slMoveValue = parsePositiveNumber(params.sl_move);
    const profitMoveValue = parsePositiveNumber(params.profit_move);
    if (!slMoveValue) {
      return { ok: false, error: "sl_move must be a positive number when trail SL is enabled." };
    }
    if (!profitMoveValue) {
      return {
        ok: false,
        error: "profit_move must be a positive number when trail SL is enabled.",
      };
    }
    params.sl_move = formatNumber(slMoveValue);
    params.profit_move = formatNumber(profitMoveValue);
  }

  return { ok: true, params };
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
      headers: { Accept: "application/json" },
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

function extractErrorMessage(payload) {
  if (!payload) return "Market Maya request failed";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return String(payload);

  const candidates = ["message", "error", "description", "msg", "detail"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  try {
    return JSON.stringify(payload);
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
      error: `Market Maya API error (${result.status}): ${extractErrorMessage(result.payload)}`,
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
        error: extractErrorMessage(result.payload),
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
        error: extractErrorMessage(result.payload),
        result,
      };
    }
    return { ok: true, dryRun: false, result };
  }

  return buildPreview({ path, token: resolvedToken, params: {}, baseUrl });
}

module.exports = {
  resolveToken,
  customTrade,
  getCallHistory,
  getSymbolPosition,
};
