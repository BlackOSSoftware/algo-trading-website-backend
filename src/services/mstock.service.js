const https = require("https");
const { getGlobalMStockConfig } = require("../models/mstockConfig.model");
const DEFAULT_BASE_URL = "https://api.mstock.trade";
const DEFAULT_TIME_ZONE =
  normalizeString(process.env.MSTOCK_TIME_ZONE || process.env.APP_TIME_ZONE) || "Asia/Kolkata";
const TYPE_A_INTERVALS = new Set([
  "minute",
  "3minute",
  "5minute",
  "10minute",
  "15minute",
  "30minute",
  "60minute",
  "day",
]);
const TYPE_B_INTERVAL_MAP = {
  minute: "ONE_MINUTE",
  "3minute": "THREE_MINUTE",
  "5minute": "FIVE_MINUTE",
  "10minute": "TEN_MINUTE",
  "15minute": "FIFTEEN_MINUTE",
  "30minute": "THIRTY_MINUTE",
  "60minute": "ONE_HOUR",
  day: "ONE_DAY",
};
const INTERVAL_DURATION_MS = {
  minute: 60 * 1000,
  "3minute": 3 * 60 * 1000,
  "5minute": 5 * 60 * 1000,
  "10minute": 10 * 60 * 1000,
  "15minute": 15 * 60 * 1000,
  "30minute": 30 * 60 * 1000,
  "60minute": 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};
const TYPE_B_EXCHANGE_CODE_MAP = {
  NSE: "1",
  NFO: "2",
  CDS: "3",
  BSE: "4",
  BFO: "5",
};
const TYPE_B_SCRIPT_MASTER_CACHE_TTL_MS = 15 * 60 * 1000;
let typeBScriptMasterEqCache = null;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeApiType(value) {
  const compact = normalizeString(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compact || compact === "typea" || compact === "a") return "typeA";
  if (compact === "typeb" || compact === "b") return "typeB";
  return "";
}

function normalizeInterval(value) {
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
  return "";
}

function normalizePositiveInt(value, fallback = null, max = 500) {
  const numeric = value === undefined || value === null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(numeric), max));
}

function isPlaceholderInstrumentToken(value) {
  const compact = normalizeString(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compact) return false;
  return (
    compact === "a" ||
    compact === "b" ||
    compact === "typea" ||
    compact === "typeb" ||
    compact === "instrumenttoken" ||
    compact === "symboltoken" ||
    compact === "token"
  );
}

function hasUsableInstrumentToken(value) {
  const token = normalizeString(value);
  if (!token) return false;
  return !isPlaceholderInstrumentToken(token);
}

function decodeJwtPayload(token) {
  const raw = normalizeString(token);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getJwtExpiryDate(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return new Date(exp * 1000);
}

function isJwtExpired(token, skewSeconds = 15) {
  const expiry = getJwtExpiryDate(token);
  if (!expiry || Number.isNaN(expiry.valueOf())) return false;
  return expiry.getTime() <= Date.now() + skewSeconds * 1000;
}

function getTimeoutMs() {
  const raw = Number(process.env.MSTOCK_TIMEOUT_MS || 15000);
  if (!Number.isFinite(raw) || raw <= 0) return 15000;
  return Math.min(raw, 60000);
}

function getDateTimeParts(dateInput, timeZone = DEFAULT_TIME_ZONE) {
  const date =
    dateInput instanceof Date && !Number.isNaN(dateInput.valueOf())
      ? dateInput
      : new Date(dateInput || Date.now());
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const values = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  });
  return {
    year: values.year || "1970",
    month: values.month || "01",
    day: values.day || "01",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00",
  };
}

function formatMStockDateTime(dateInput, withSeconds = true) {
  const parts = getDateTimeParts(dateInput);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${
    withSeconds ? `:${parts.second}` : ""
  }`;
}

function buildHistoricalRange(interval, receivedAt, candleOffset) {
  const reference =
    receivedAt instanceof Date && !Number.isNaN(receivedAt.valueOf())
      ? receivedAt
      : new Date(receivedAt || Date.now());
  const durationMs = INTERVAL_DURATION_MS[interval] || INTERVAL_DURATION_MS.minute;
  const offset = normalizePositiveInt(candleOffset, 1, 200) || 1;
  const lookbackBars = interval === "day" ? Math.max(offset + 10, 20) : Math.max(offset + 5, 8);

  return {
    from: new Date(reference.getTime() - durationMs * lookbackBars),
    to: reference,
  };
}

function buildHeaders({ apiType, apiKey, authToken, contentType = "" }) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Mirae-Version": "1",
  };

  if (apiType === "typeA") {
    headers.Authorization = `token ${apiKey}:${authToken}`;
  } else {
    headers.Authorization = `Bearer ${authToken}`;
    headers["X-PrivateKey"] = apiKey;
  }

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}

function normalizePayloadStatus(payload) {
  const rawStatus = payload?.status;
  if (typeof rawStatus === "boolean") {
    return rawStatus ? "success" : "error";
  }
  if (typeof rawStatus === "number") {
    return rawStatus === 1 ? "success" : rawStatus === 0 ? "error" : String(rawStatus);
  }

  const status = normalizeString(rawStatus).toLowerCase();
  if (!status) return "";
  if (status === "success" || status === "true") return "success";
  if (status === "error" || status === "false") return "error";
  return status;
}

function extractErrorMessage(payload, status) {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed || `mStock API error (${status})`;
  }
  if (payload && typeof payload === "object") {
    const message = normalizeString(payload.message || payload.error || payload.error_type);
    if (message) return message;
  }
  return status ? `mStock API error (${status})` : "mStock API request failed";
}

async function fetchMStock(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text().catch(() => "");
    let payload = rawText;
    if (contentType.includes("application/json")) {
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = rawText;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildTypeBSessionHeaders(apiKey, contentType = "application/json") {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Mirae-Version": "1",
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (normalizeString(apiKey)) {
    headers["X-PrivateKey"] = normalizeString(apiKey);
  }
  return headers;
}

function extractSessionData(payload) {
  if (!payload || typeof payload !== "object") return {};
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;

  return {
    jwtToken: normalizeString(data.jwtToken || data.jwt_token),
    refreshToken: normalizeString(data.refreshToken || data.refresh_token),
    feedToken: normalizeString(data.feedToken || data.feed_token),
    clientCode: normalizeString(data.clientCode || data.clientcode || data.client_code),
    state: normalizeString(data.state),
    requestTime: normalizeString(
      data.requestTime || data.request_time || payload.requestTime || payload.request_time
    ),
  };
}

function toUserApiResult(step, response) {
  const payloadStatus = normalizePayloadStatus(response.payload);
  const ok = Boolean(response.ok) && payloadStatus !== "error";
  const message = extractErrorMessage(response.payload, response.status);
  const session = extractSessionData(response.payload);

  return {
    ok,
    step,
    status: Number(response.status || 0),
    message,
    payload: response.payload,
    session,
  };
}

async function postMStockJson(url, body, headers = {}) {
  return fetchMStock(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
}

async function typeBConnectLogin({ clientCode, password, state = "", apiKey = "", totp = "" }) {
  const url = `${DEFAULT_BASE_URL}/openapi/typeb/connect/login`;
  const response = await postMStockJson(
    url,
    {
      clientcode: normalizeString(clientCode),
      password: normalizeString(password),
      totp: normalizeString(totp),
      state: normalizeString(state),
    },
    buildTypeBSessionHeaders(apiKey)
  );

  const result = toUserApiResult("login", response);
  const requestToken = normalizeString(result.session?.refreshToken || result.session?.jwtToken);
  const message = "Login started. OTP/TOTP verification is still required.";

  return {
    ...result,
    message,
    session: {
      ...(result.session || {}),
      jwtToken: "",
      refreshToken: requestToken,
      feedToken: "",
    },
    nextAction: "otpOrTotp",
  };
}

async function typeBSessionToken({ apiKey, refreshToken, otp }) {
  const url = `${DEFAULT_BASE_URL}/openapi/typeb/session/token`;
  const response = await postMStockJson(
    url,
    {
      refreshToken: normalizeString(refreshToken),
      otp: normalizeString(otp),
    },
    buildTypeBSessionHeaders(apiKey)
  );

  return {
    ...toUserApiResult("otp", response),
    nextAction: null,
  };
}

async function typeBVerifyTotp({ apiKey, refreshToken, totp }) {
  const url = `${DEFAULT_BASE_URL}/openapi/typeb/session/verifytotp`;
  const response = await postMStockJson(
    url,
    {
      refreshToken: normalizeString(refreshToken),
      totp: normalizeString(totp),
    },
    buildTypeBSessionHeaders(apiKey)
  );

  return {
    ...toUserApiResult("totp", response),
    nextAction: null,
  };
}

async function requestMStockWithBody(url, { method = "GET", headers = {}, body = "" }) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
        timeout: getTimeoutMs(),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          const contentType = String(res.headers["content-type"] || "");
          let payload = rawText;
          if (contentType.includes("application/json")) {
            try {
              payload = rawText ? JSON.parse(rawText) : {};
            } catch {
              payload = rawText;
            }
          }

          const status = Number(res.statusCode || 0);
          resolve({
            ok: status >= 200 && status < 300,
            status,
            payload,
          });
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("mStock request timed out")));

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function parseCandle(entry) {
  if (!Array.isArray(entry) || entry.length < 5) return null;
  const timestamp = normalizeString(entry[0]);
  const open = Number(entry[1]);
  const high = Number(entry[2]);
  const low = Number(entry[3]);
  const close = Number(entry[4]);
  const volume = entry.length > 5 ? Number(entry[5]) : null;
  if (!timestamp) return null;
  if (![open, high, low, close].every((value) => Number.isFinite(value))) {
    return null;
  }
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : null,
  };
}

function extractCandles(payload) {
  const rawCandles = Array.isArray(payload?.data?.candles) ? payload.data.candles : [];
  return rawCandles
    .map(parseCandle)
    .filter(Boolean)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function pickCandle(candles, candleOffset) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const offset = normalizePositiveInt(candleOffset, 1, 200) || 1;
  const index = candles.length - offset;
  if (index >= 0) return candles[index];
  return candles[0];
}

function summarizeDiagnosticResponse(response) {
  if (!response) return null;
  return {
    ok: Boolean(response.ok),
    status: Number(response.status || 0),
    payloadStatus: normalizePayloadStatus(response.payload),
    message: extractErrorMessage(response.payload, response.status),
    payload: response.payload,
  };
}

function deriveMarketDataFailureReason(checks) {
  const historicalMessage = normalizeString(checks?.historical?.message);
  if (historicalMessage) {
    const status = Number(checks?.historical?.status || 0);
    return status > 0 ? `Historical API failed (${status}): ${historicalMessage}` : historicalMessage;
  }

  const quoteMessage = normalizeString(checks?.quote?.message);
  if (quoteMessage) {
    const status = Number(checks?.quote?.status || 0);
    return status > 0 ? `Quote API failed (${status}): ${quoteMessage}` : quoteMessage;
  }

  const scriptMasterMessage = normalizeString(checks?.scriptMaster?.message);
  if (scriptMasterMessage && checks?.scriptMaster?.ok === false) {
    return `Script master failed: ${scriptMasterMessage}`;
  }

  return "mStock market data test failed.";
}

function getPriceField(source) {
  const normalized = normalizeString(source).toLowerCase();
  if (normalized === "mstocklow") return "low";
  if (normalized === "mstockopen") return "open";
  if (normalized === "mstockclose") return "close";
  return "high";
}

async function fetchTypeAHistorical({
  apiKey,
  authToken,
  exchange,
  instrumentToken,
  interval,
  from,
  to,
}) {
  const params = new URLSearchParams();
  params.set("from", formatMStockDateTime(from, true));
  params.set("to", formatMStockDateTime(to, true));
  const url = `${DEFAULT_BASE_URL}/openapi/typea/instruments/historical/${encodeURIComponent(
    exchange
  )}/${encodeURIComponent(instrumentToken)}/${encodeURIComponent(interval)}?${params.toString()}`;

  return fetchMStock(url, {
    method: "GET",
    headers: buildHeaders({
      apiType: "typeA",
      apiKey,
      authToken,
    }),
  });
}

async function fetchTypeBHistorical({
  apiKey,
  authToken,
  exchange,
  instrumentToken,
  interval,
  from,
  to,
}) {
  const url = `${DEFAULT_BASE_URL}/openapi/typeb/instruments/historical`;
  return requestMStockWithBody(url, {
    method: "GET",
    headers: buildHeaders({
      apiType: "typeB",
      apiKey,
      authToken,
      contentType: "application/json",
    }),
    body: JSON.stringify({
      exchange,
      symboltoken: instrumentToken,
      interval: TYPE_B_INTERVAL_MAP[interval],
      fromdate: formatMStockDateTime(from, false),
      todate: formatMStockDateTime(to, false),
    }),
  });
}

async function fetchTypeBIntraday({
  apiKey,
  authToken,
  exchange,
  instrumentToken,
  interval,
}) {
  const exchangeCode = TYPE_B_EXCHANGE_CODE_MAP[normalizeString(exchange).toUpperCase()] || "";
  if (!exchangeCode) {
    return {
      ok: false,
      status: 400,
      payload: {
        message: `Unsupported mStock Type B intraday exchange: ${exchange}`,
      },
    };
  }

  const url = `${DEFAULT_BASE_URL}/openapi/typeb/instruments/intraday`;
  return postMStockJson(
    url,
    {
      exchange: exchangeCode,
      symboltoken: instrumentToken,
      interval: TYPE_B_INTERVAL_MAP[interval],
    },
    buildHeaders({
      apiType: "typeB",
      apiKey,
      authToken,
      contentType: "application/json",
    })
  );
}

async function fetchTypeBQuote({
  apiKey,
  authToken,
  exchange,
  instrumentToken,
}) {
  const url = `${DEFAULT_BASE_URL}/openapi/typeb/instruments/quote`;
  return requestMStockWithBody(url, {
    method: "GET",
    headers: buildHeaders({
      apiType: "typeB",
      apiKey,
      authToken,
      contentType: "application/json",
    }),
    body: JSON.stringify({
      mode: "OHLC",
      exchangeTokens: {
        [exchange]: [instrumentToken],
      },
    }),
  });
}

async function fetchTypeBScriptMaster({ apiKey, authToken }) {
  const url = `${DEFAULT_BASE_URL}/openapi/typeb/instruments/OpenAPIScripMaster`;
  const response = await fetchMStock(url, {
    method: "GET",
    headers: buildHeaders({
      apiType: "typeB",
      apiKey,
      authToken,
    }),
  });

  if (!response.ok) {
    return response;
  }

  const payload = response.payload;
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  return {
    ...response,
    entries,
  };
}

function buildTypeBEqIndex(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const exchange = normalizeString(entry.exch_seg).toUpperCase();
    const symbol = normalizeString(entry.symbol).toUpperCase();
    const token = normalizeString(entry.token);
    const instrumentType = normalizeString(entry.instrumenttype).toUpperCase();
    const expiry = normalizeString(entry.expiry);
    const name = normalizeString(entry.name).toUpperCase();
    const isEq =
      instrumentType === "EQ" ||
      instrumentType === "EQUITY" ||
      (!expiry && (name.endsWith("-EQ") || name.endsWith("-A")));

    if (!exchange || !symbol || !token || !isEq) continue;

    if (!index.has(exchange)) {
      index.set(exchange, new Map());
    }
    const exchangeIndex = index.get(exchange);
    if (!exchangeIndex.has(symbol)) {
      exchangeIndex.set(symbol, token);
    }
  }
  return index;
}

async function getTypeBEqTokenIndex({ apiKey, authToken }) {
  if (
    typeBScriptMasterEqCache &&
    typeBScriptMasterEqCache.expiresAt > Date.now() &&
    typeBScriptMasterEqCache.index
  ) {
    return typeBScriptMasterEqCache.index;
  }

  const response = await fetchTypeBScriptMaster({ apiKey, authToken });
  if (!response.ok) {
    throw new Error(extractErrorMessage(response.payload, response.status));
  }

  const index = buildTypeBEqIndex(response.entries);
  typeBScriptMasterEqCache = {
    index,
    expiresAt: Date.now() + TYPE_B_SCRIPT_MASTER_CACHE_TTL_MS,
  };
  return index;
}

async function resolveTypeBEqInstrumentToken({ apiKey, authToken, exchange, symbol }) {
  const normalizedExchange = normalizeString(exchange).toUpperCase();
  const normalizedSymbol = normalizeString(symbol).toUpperCase();
  if (!normalizedExchange || !normalizedSymbol) return "";

  const index = await getTypeBEqTokenIndex({ apiKey, authToken });
  return normalizeString(index.get(normalizedExchange)?.get(normalizedSymbol));
}

async function resolveMStockCandlePrice({ config, source, receivedAt, symbol = "", segment = "" }) {
  const cfg = config && typeof config === "object" ? config : {};
  const globalConfig = (await getGlobalMStockConfig().catch(() => null)) || {};
  const apiType = normalizeApiType(
    cfg.mStockApiType || globalConfig.apiType || process.env.MSTOCK_API_TYPE
  );
  const apiKey = normalizeString(
    cfg.mStockApiKey || globalConfig.apiKey || process.env.MSTOCK_API_KEY
  );
  const authToken = normalizeString(
    cfg.mStockAuthToken || globalConfig.authToken || process.env.MSTOCK_AUTH_TOKEN
  );
  const exchange = normalizeString(
    cfg.mStockExchange || globalConfig.exchange || process.env.MSTOCK_EXCHANGE
  ).toUpperCase();
  const normalizedSegment = normalizeString(segment || cfg.segment).toUpperCase();
  const runtimeSymbol = normalizeString(symbol).toUpperCase();
  const configuredInstrumentToken = normalizeString(
    hasUsableInstrumentToken(cfg.mStockInstrumentToken)
      ? cfg.mStockInstrumentToken
      : hasUsableInstrumentToken(globalConfig.instrumentToken)
        ? globalConfig.instrumentToken
        : hasUsableInstrumentToken(process.env.MSTOCK_INSTRUMENT_TOKEN)
          ? process.env.MSTOCK_INSTRUMENT_TOKEN
          : ""
  );
  const interval = normalizeInterval(
    cfg.mStockInterval || globalConfig.interval || process.env.MSTOCK_INTERVAL
  );
  const candleOffset =
    normalizePositiveInt(
      cfg.mStockCandleOffset ?? globalConfig.candleOffset ?? process.env.MSTOCK_CANDLE_OFFSET,
      1,
      200
    ) || 1;
  const priceField = getPriceField(source);

  if (!apiType) {
    return { ok: false, error: "mStock API type is required for candle price source" };
  }
  if (!apiKey) {
    return {
      ok: false,
      error: "Admin mStock defaults are incomplete: API key is not saved. Open Admin -> mStock Access.",
    };
  }
  if (!authToken) {
    return {
      ok: false,
      error: "Admin mStock defaults are incomplete: JWT token is not saved. Open Admin -> mStock Access.",
    };
  }
  if (isJwtExpired(authToken)) {
    const expiry = getJwtExpiryDate(authToken);
    return {
      ok: false,
      error: `Admin mStock JWT expired${expiry ? ` at ${expiry.toISOString()}` : ""}. Open Admin -> mStock Access and login again.`,
    };
  }
  if (!exchange) {
    return {
      ok: false,
      error: "Admin mStock candle defaults are incomplete: exchange is not saved. Open Admin -> mStock Access and save Candle Defaults.",
    };
  }
  let instrumentToken = configuredInstrumentToken;
  if (apiType === "typeB" && normalizedSegment === "EQ" && runtimeSymbol) {
    try {
      instrumentToken =
        (await resolveTypeBEqInstrumentToken({
          apiKey,
          authToken,
          exchange,
          symbol: runtimeSymbol,
        })) || "";
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "mStock script master lookup failed",
      };
    }
  }
  if (!instrumentToken) {
    return {
      ok: false,
      error:
        apiType === "typeB" && normalizedSegment === "EQ" && runtimeSymbol
          ? `mStock Type B symboltoken could not be auto-resolved for ${exchange}:${runtimeSymbol}.`
          : isPlaceholderInstrumentToken(
                cfg.mStockInstrumentToken ||
                  globalConfig.instrumentToken ||
                  process.env.MSTOCK_INSTRUMENT_TOKEN
              )
            ? "Admin mStock candle defaults look invalid: symboltoken / instrument token is saved as placeholder text. Open Admin -> mStock Access and replace it with the real symboltoken."
            : "Admin mStock candle defaults are incomplete: symboltoken / instrument token is not saved. Open Admin -> mStock Access and save Candle Defaults.",
    };
  }
  if (!interval || !TYPE_A_INTERVALS.has(interval)) {
    return {
      ok: false,
      error: "Admin mStock candle defaults are incomplete: candle timeframe is not saved or invalid. Open Admin -> mStock Access and save Candle Defaults.",
    };
  }

  const { from, to } = buildHistoricalRange(interval, receivedAt, candleOffset);
  let response;
  try {
    response =
      apiType === "typeB"
        ? interval === "day"
          ? await fetchTypeBHistorical({
              apiKey,
              authToken,
              exchange,
              instrumentToken,
              interval,
              from,
              to,
            })
          : await fetchTypeBIntraday({
              apiKey,
              authToken,
              exchange,
              instrumentToken,
              interval,
            })
        : interval === "day"
          ? await fetchTypeAHistorical({
              apiKey,
              authToken,
              exchange,
              instrumentToken,
              interval,
              from,
              to,
            })
          : await fetchTypeAHistorical({
              apiKey,
              authToken,
              exchange,
              instrumentToken,
              interval,
              from,
              to,
            });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "mStock candle request failed",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: extractErrorMessage(response.payload, response.status),
    };
  }

  const payloadStatus = normalizePayloadStatus(response.payload);
  if (payloadStatus === "error") {
    return {
      ok: false,
      error: extractErrorMessage(response.payload, response.status),
    };
  }

  const candles = extractCandles(response.payload);
  if (candles.length === 0) {
    return { ok: false, error: "mStock candle data not found for the configured instrument" };
  }

  const candle = pickCandle(candles, candleOffset);
  const price = Number(candle?.[priceField]);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: `mStock candle ${priceField} price is invalid` };
  }

  return {
    ok: true,
    price,
    candle,
    apiType,
    interval,
    priceField,
  };
}

async function testMStockMarketData({
  symbol = "ONGC",
  segment = "EQ",
  exchange = "",
  interval = "",
} = {}) {
  const globalConfig = (await getGlobalMStockConfig().catch(() => null)) || {};
  const apiType = normalizeApiType(globalConfig.apiType || process.env.MSTOCK_API_TYPE);
  const apiKey = normalizeString(globalConfig.apiKey || process.env.MSTOCK_API_KEY);
  const authToken = normalizeString(globalConfig.authToken || process.env.MSTOCK_AUTH_TOKEN);
  const resolvedExchange = normalizeString(
    exchange || globalConfig.exchange || process.env.MSTOCK_EXCHANGE
  ).toUpperCase();
  const resolvedInterval = normalizeInterval(
    interval || globalConfig.interval || process.env.MSTOCK_INTERVAL
  );
  const runtimeSymbol = normalizeString(symbol).toUpperCase();
  const normalizedSegment = normalizeString(segment).toUpperCase() || "EQ";
  const expiry = getJwtExpiryDate(authToken);

  if (!apiType) return { ok: false, error: "mStock API type is not configured." };
  if (!apiKey) return { ok: false, error: "mStock API key is not configured." };
  if (!authToken) return { ok: false, error: "mStock JWT token is not configured." };
  if (isJwtExpired(authToken)) {
    return {
      ok: false,
      error: `mStock JWT expired${expiry ? ` at ${expiry.toISOString()}` : ""}.`,
      authTokenExpiresAt: expiry ? expiry.toISOString() : "",
    };
  }
  if (!resolvedExchange) return { ok: false, error: "mStock exchange is not configured." };
  if (!resolvedInterval) return { ok: false, error: "mStock candle interval is not configured." };
  if (!runtimeSymbol) return { ok: false, error: "Symbol is required." };

  let instrumentToken = "";
  let scriptMasterSummary = null;

  if (apiType === "typeB" && normalizedSegment === "EQ") {
    try {
      instrumentToken =
        (await resolveTypeBEqInstrumentToken({
          apiKey,
          authToken,
          exchange: resolvedExchange,
          symbol: runtimeSymbol,
        })) || "";
      scriptMasterSummary = {
        ok: Boolean(instrumentToken),
        status: 200,
        message: instrumentToken
          ? "Instrument token resolved from script master."
          : "Instrument token not found in script master.",
      };
    } catch (error) {
      scriptMasterSummary = {
        ok: false,
        status: 0,
        message: error instanceof Error ? error.message : "Script master lookup failed",
      };
    }
  } else {
    instrumentToken = normalizeString(globalConfig.instrumentToken || process.env.MSTOCK_INSTRUMENT_TOKEN);
  }

  if (!instrumentToken) {
    return {
      ok: false,
      error: `Instrument token could not be resolved for ${resolvedExchange}:${runtimeSymbol}.`,
      apiType,
      exchange: resolvedExchange,
      interval: resolvedInterval,
      symbol: runtimeSymbol,
      segment: normalizedSegment,
      authTokenExpiresAt: expiry ? expiry.toISOString() : "",
      checks: {
        scriptMaster: scriptMasterSummary,
      },
    };
  }

  const now = new Date();
  const { from, to } = buildHistoricalRange(resolvedInterval, now, 1);
  let quoteResponse = null;
  let historicalResponse = null;

  try {
    if (apiType === "typeB") {
      quoteResponse = await fetchTypeBQuote({
        apiKey,
        authToken,
        exchange: resolvedExchange,
        instrumentToken,
      });
      historicalResponse =
        resolvedInterval === "day"
          ? await fetchTypeBHistorical({
              apiKey,
              authToken,
              exchange: resolvedExchange,
              instrumentToken,
              interval: resolvedInterval,
              from,
              to,
            })
          : await fetchTypeBIntraday({
              apiKey,
              authToken,
              exchange: resolvedExchange,
              instrumentToken,
              interval: resolvedInterval,
            });
    } else {
      historicalResponse = await fetchTypeAHistorical({
        apiKey,
        authToken,
        exchange: resolvedExchange,
        instrumentToken,
        interval: resolvedInterval,
        from,
        to,
      });
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "mStock market data test failed",
      apiType,
      exchange: resolvedExchange,
      interval: resolvedInterval,
      symbol: runtimeSymbol,
      segment: normalizedSegment,
      instrumentToken,
      authTokenExpiresAt: expiry ? expiry.toISOString() : "",
      checks: {
        scriptMaster: scriptMasterSummary,
      },
    };
  }

  const candles = historicalResponse?.ok ? extractCandles(historicalResponse.payload) : [];
  const candle = candles.length > 0 ? pickCandle(candles, 1) : null;
  const checks = {
    scriptMaster: scriptMasterSummary,
    ...(quoteResponse ? { quote: summarizeDiagnosticResponse(quoteResponse) } : {}),
    ...(historicalResponse ? { historical: summarizeDiagnosticResponse(historicalResponse) } : {}),
  };
  const error = candle ? "" : deriveMarketDataFailureReason(checks);

  return {
    ok: Boolean(candle),
    message: candle
      ? "mStock market data test passed."
      : "mStock market data test failed.",
    ...(error ? { error } : {}),
    apiType,
    exchange: resolvedExchange,
    interval: resolvedInterval,
    symbol: runtimeSymbol,
    segment: normalizedSegment,
    instrumentToken,
    authTokenExpiresAt: expiry ? expiry.toISOString() : "",
    candle,
    checks,
  };
}

module.exports = {
  normalizeApiType,
  normalizeInterval,
  resolveMStockCandlePrice,
  testMStockMarketData,
  typeBConnectLogin,
  typeBSessionToken,
  typeBVerifyTotp,
};
