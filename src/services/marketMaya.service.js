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

  const path = "/custom-trade";
  if (!isTruthy(execute)) {
    return buildPreview({ path, token: resolvedToken, params, baseUrl });
  }

  const url = buildUrl(path, resolvedToken, params, baseUrl);
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
