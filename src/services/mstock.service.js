const https = require("https");
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
  const status = normalizeString(payload?.status).toLowerCase();
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
  return rawCandles.map(parseCandle).filter(Boolean);
}

function pickCandle(candles, candleOffset) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const offset = normalizePositiveInt(candleOffset, 1, 200) || 1;
  const index = candles.length - offset;
  if (index >= 0) return candles[index];
  return candles[0];
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

async function resolveMStockCandlePrice({ config, source, receivedAt }) {
  const cfg = config && typeof config === "object" ? config : {};
  const apiType = normalizeApiType(cfg.mStockApiType || process.env.MSTOCK_API_TYPE);
  const apiKey = normalizeString(cfg.mStockApiKey || process.env.MSTOCK_API_KEY);
  const authToken = normalizeString(cfg.mStockAuthToken || process.env.MSTOCK_AUTH_TOKEN);
  const exchange = normalizeString(cfg.mStockExchange || process.env.MSTOCK_EXCHANGE).toUpperCase();
  const instrumentToken = normalizeString(
    cfg.mStockInstrumentToken || process.env.MSTOCK_INSTRUMENT_TOKEN
  );
  const interval = normalizeInterval(cfg.mStockInterval || process.env.MSTOCK_INTERVAL);
  const candleOffset =
    normalizePositiveInt(
      cfg.mStockCandleOffset ?? process.env.MSTOCK_CANDLE_OFFSET,
      1,
      200
    ) || 1;
  const priceField = getPriceField(source);

  if (!apiType) {
    return { ok: false, error: "mStock API type is required for candle price source" };
  }
  if (!apiKey) {
    return { ok: false, error: "mStock API key is required for candle price source" };
  }
  if (!authToken) {
    return { ok: false, error: "mStock access/JWT token is required for candle price source" };
  }
  if (!exchange) {
    return { ok: false, error: "mStock exchange is required for candle price source" };
  }
  if (!instrumentToken) {
    return {
      ok: false,
      error: "mStock instrument token / symbol token is required for candle price source",
    };
  }
  if (!interval || !TYPE_A_INTERVALS.has(interval)) {
    return { ok: false, error: "mStock candle interval is invalid" };
  }

  const { from, to } = buildHistoricalRange(interval, receivedAt, candleOffset);
  let response;
  try {
    response =
      apiType === "typeB"
        ? await fetchTypeBHistorical({
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

module.exports = {
  normalizeApiType,
  normalizeInterval,
  resolveMStockCandlePrice,
};
