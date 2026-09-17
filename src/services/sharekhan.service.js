const crypto = require("crypto");
const { resolveInstrumentForOrder } = require("../models/mstockInstrument.model");
const https = require("https");

const DEFAULT_BASE_URL = "https://api.sharekhan.com";
const PLACE_ORDER_PATH = "/skapi/services/orders";
const ACCESS_TOKEN_PATH = "/skapi/services/access/token";
const LOGIN_PATH = "/skapi/auth/login.html";
const ZERO_IV = Buffer.alloc(16, 0);

const EXCHANGE_MAP = {
  NSE: "NC",
  BSE: "BC",
  NFO: "NF",
  BFO: "BF",
  CDS: "CD",
  MCX: "MX",
  NC: "NC",
  BC: "BC",
  NF: "NF",
  BF: "BF",
  CD: "CD",
  MX: "MX",
};

function normalizeString(value) {
  return String(value || "").trim();
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function getTimeoutMs() {
  const raw = Number(process.env.SHAREKHAN_TIMEOUT_MS || process.env.MSTOCK_TIMEOUT_MS || 15000);
  if (!Number.isFinite(raw) || raw <= 0) return 15000;
  return Math.min(raw, 60000);
}

function mapCallTypeToTransaction(callType) {
  const raw = normalizeString(callType).toUpperCase();
  if (!raw) return "";
  if (raw === "BUY" || raw === "BUY ADD" || raw === "B") return "B";
  if (raw === "SELL" || raw === "SELL ADD" || raw === "S") return "S";
  if (raw === "BUY EXIT" || raw === "PARTIAL BUY EXIT") return "S";
  if (raw === "SELL EXIT" || raw === "PARTIAL SELL EXIT") return "B";
  if (raw.includes("SELL")) return "S";
  if (raw.includes("BUY")) return "B";
  return "";
}

function mapExchangeCode(exchange) {
  const key = normalizeString(exchange).toUpperCase();
  return EXCHANGE_MAP[key] || key;
}

function resolveProductType({ segment, productType }) {
  const explicit = normalizeString(productType).toUpperCase();
  if (["INVESTMENT", "INV", "BIGTRADE", "BT", "BIGTRADEPLUS", "BT+"].includes(explicit)) {
    if (explicit === "INV") return "INVESTMENT";
    if (explicit === "BT") return "BIGTRADE";
    if (explicit === "BT+") return "BIGTRADEPLUS";
    return explicit;
  }
  // Legacy mStock-style values from earlier UI.
  if (explicit === "DELIVERY") return "INVESTMENT";
  if (explicit === "INTRADAY") return "BIGTRADE";
  if (explicit === "CARRYFORWARD" || explicit === "MARGIN") return "INVESTMENT";

  const seg = normalizeString(segment).toUpperCase();
  if (seg === "FUT" || seg === "OPT") return "INVESTMENT";
  return "INVESTMENT";
}

function resolveInstrumentType(segment, instrumentType) {
  const type = normalizeString(instrumentType).toUpperCase();
  const seg = normalizeString(segment).toUpperCase();
  if (seg === "EQ") return "";
  if (type) {
    if (/FUTSTK|FS/.test(type)) return "FS";
    if (/FUTIDX|FI/.test(type)) return "FI";
    if (/OPTSTK|OS/.test(type)) return "OS";
    if (/OPTIDX|OI/.test(type)) return "OI";
    if (/FUTCOM|FUTCUR/.test(type)) return "FS";
  }
  if (seg === "FUT") return "FS";
  if (seg === "OPT") return "OS";
  return "";
}

function formatSharekhanExpiry(expiry) {
  const raw = normalizeString(expiry);
  if (!raw) return "";
  // Already dd/MM/yyyy
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw;
  // yyyy-MM-dd
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  // dd-MM-yyyy
  const dash = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (dash) return `${dash[1]}/${dash[2]}/${dash[3]}`;
  return raw;
}

function extractErrorMessage(payload, status) {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed || `Sharekhan API error (${status})`;
  }
  if (payload && typeof payload === "object") {
    const direct =
      payload.message ||
      payload.error ||
      payload.errorMessage ||
      payload.error_message ||
      payload.error_type ||
      payload.statusMessage ||
      payload.status_message ||
      payload.remarks ||
      payload.remark ||
      payload.reason ||
      payload.description;
    const nested =
      payload.data ||
      payload.result ||
      payload.response ||
      payload.payload ||
      (Array.isArray(payload.errors) ? payload.errors[0] : payload.errors);
    const message = normalizeString(direct) || (nested !== payload ? extractErrorMessage(nested, "") : "");
    if (message) return message;
  }
  return status ? `Sharekhan API error (${status})` : "Sharekhan API request failed";
}

function sanitizeSharekhanPayload(value, depth = 0) {
  if (depth > 4) return "[Nested response omitted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length > 600 ? `${trimmed.slice(0, 597)}...` : trimmed;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => sanitizeSharekhanPayload(item, depth + 1));
  }
  const blocked = new Set([
    "access-token",
    "accessToken",
    "authorization",
    "api-key",
    "apiKey",
    "secureKey",
    "secretKey",
    "token",
  ]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeSharekhanPayload(item, depth + 1);
  }
  return output;
}

function isSharekhanReadRequestError(response) {
  const detail = normalizeString(response?.payload?.detail || response?.payload?.message || response?.payload);
  return Number(response?.status) === 400 && /failed to read request/i.test(detail);
}

function buildSharekhanParserRetryBody(orderBody) {
  const retry = { ...orderBody };
  // Some Sharekhan deployments are strict about numeric JSON types even though SDK docs show mixed strings.
  for (const key of ["price", "triggerPrice", "strikePrice"]) {
    if (retry[key] !== undefined && retry[key] !== "" && retry[key] !== "-1") {
      const numeric = Number(retry[key]);
      if (Number.isFinite(numeric)) retry[key] = numeric;
    }
  }
  for (const key of ["scripCode", "quantity", "disclosedQty"]) {
    if (retry[key] !== undefined && retry[key] !== "") {
      const numeric = Number(retry[key]);
      if (Number.isFinite(numeric)) retry[key] = Math.trunc(numeric);
    }
  }
  return retry;
}

async function fetchSharekhan(url, { method = "GET", headers = {}, body = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : body,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text().catch(() => "");
    let payload = rawText;
    if (contentType.includes("application/json") || rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
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

function buildSharekhanHeaders({ apiKey, accessToken }) {
  return {
    "Content-Type": "application/json",
    "api-key": normalizeString(apiKey),
    "access-token": normalizeString(accessToken),
  };
}

function fetchSharekhanNodeHttp(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const requestHeaders = { ...headers };
    if (body != null) {
      requestHeaders["Content-Length"] = String(Buffer.byteLength(String(body), "utf8"));
    }
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
        timeout: getTimeoutMs(),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          let payload = rawText;
          if (rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
            try {
              payload = rawText ? JSON.parse(rawText) : {};
            } catch {
              payload = rawText;
            }
          }
          const status = Number(res.statusCode || 0);
          resolve({ ok: status >= 200 && status < 300, status, payload });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Sharekhan API request timed out")));
    req.on("error", (err) => {
      resolve({
        ok: false,
        status: 0,
        payload: { message: err instanceof Error ? err.message : "Sharekhan API request failed" },
      });
    });
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Place order on Mirae Asset Sharekhan ShareConnect API.
 * Uses ONLY the user's own apiKey + accessToken + customerId (never admin mStock).
 */
async function placeSharekhanOrder({
  apiKey,
  accessToken,
  customerId,
  channelUser,
  execute = false,
  exchange,
  segment,
  symbol,
  symbolToken,
  callType,
  quantity,
  productType,
  price = "0",
  triggerPrice = "0",
  orderType = "NORMAL",
  afterHour = "N",
  validity = "GFD",
}) {
  const resolvedApiKey = normalizeString(apiKey);
  const resolvedAccessToken = normalizeString(accessToken);
  const resolvedCustomerId = normalizeString(customerId);
  const resolvedChannelUser = normalizeString(channelUser) || resolvedCustomerId;

  const transactionType = mapCallTypeToTransaction(callType);
  if (!transactionType) {
    return { ok: false, dryRun: true, error: "Invalid call_type for Sharekhan order" };
  }

  const qty = normalizeString(quantity) || "1";
  if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
    return { ok: false, dryRun: true, error: "quantity must be a positive number" };
  }

  const instrument = await resolveInstrumentForOrder({
    symbol,
    exchange,
    segment,
    symbolToken,
  });
  if (!instrument?.token) {
    return {
      ok: false,
      dryRun: true,
      error: `Sharekhan instrument not found for ${normalizeString(symbol) || "symbol"} on ${
        normalizeString(exchange) || "exchange"
      }. Sync script master first.`,
    };
  }

  const sharekhanExchange = mapExchangeCode(instrument.exchange || exchange);
  const instrumentType = resolveInstrumentType(segment, instrument.instrumentType);
  const scripCode = Number(instrument.token);
  if (!Number.isFinite(scripCode) || scripCode <= 0) {
    return {
      ok: false,
      dryRun: true,
      broker: "sharekhan",
      error: `Sharekhan scripCode is invalid for ${normalizeString(symbol) || "symbol"} (${instrument.token}). Sync a Sharekhan-compatible script master/scripCode before placing orders.`,
      instrument: {
        token: instrument.token,
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        instrumentType: instrument.instrumentType,
      },
    };
  }

  // Sharekhan expects numeric customerId + channelUser matching the API login session.
  // Working API example: customerId: 1464067, channelUser: "pandurangs22"
  const customerIdForApi = /^\d+$/.test(resolvedCustomerId)
    ? Number(resolvedCustomerId)
    : resolvedCustomerId;

  const orderBody = {
    customerId: customerIdForApi,
    scripCode,
    tradingSymbol: normalizeString(instrument.symbol || symbol).toUpperCase(),
    exchange: sharekhanExchange,
    transactionType,
    quantity: Number(qty) || qty,
    disclosedQty: 0,
    price: normalizeString(price) || "0",
    triggerPrice: normalizeString(triggerPrice) || "0",
    rmsCode: "ANY",
    afterHour: normalizeString(afterHour).toUpperCase() || "N",
    orderType: normalizeString(orderType).toUpperCase() || "NORMAL",
    channelUser: resolvedChannelUser,
    validity: normalizeString(validity).toUpperCase() || "GFD",
    requestType: "NEW",
    productType: resolveProductType({ segment, productType }),
  };

  if (instrumentType) {
    orderBody.instrumentType = instrumentType;
    orderBody.strikePrice = normalizeString(instrument.strike) || "-1";
    orderBody.optionType =
      normalizeString(segment).toUpperCase() === "OPT"
        ? /PE$/i.test(String(instrument.symbol || ""))
          ? "PE"
          : "CE"
        : "XX";
    const expiry = formatSharekhanExpiry(instrument.expiry);
    if (expiry) orderBody.expiry = expiry;
  }

  if (!isTruthy(execute)) {
    return {
      ok: true,
      dryRun: true,
      broker: "sharekhan",
      credentialsReady: Boolean(resolvedApiKey && resolvedAccessToken && resolvedCustomerId),
      preview: orderBody,
      instrument: {
        token: instrument.token,
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        instrumentType: instrument.instrumentType,
      },
    };
  }

  if (!resolvedApiKey || !resolvedAccessToken || !resolvedCustomerId) {
    return {
      ok: false,
      dryRun: false,
      broker: "sharekhan",
      error:
        "Sharekhan user credentials required: API Key, Access Token, Customer ID (numeric), and Login ID (channelUser). Enter them on the strategy — not Admin mStock.",
    };
  }

  const url = `${DEFAULT_BASE_URL}${PLACE_ORDER_PATH}`;
  let requestBody = orderBody;
  let response = await fetchSharekhan(url, {
    method: "POST",
    headers: buildSharekhanHeaders({
      apiKey: resolvedApiKey,
      accessToken: resolvedAccessToken,
    }),
    body: JSON.stringify(requestBody),
  });

  if (isSharekhanReadRequestError(response)) {
    requestBody = buildSharekhanParserRetryBody(orderBody);
    response = await fetchSharekhan(url, {
      method: "POST",
      headers: buildSharekhanHeaders({
        apiKey: resolvedApiKey,
        accessToken: resolvedAccessToken,
      }),
      body: JSON.stringify(requestBody),
    });
  }

  if (isSharekhanReadRequestError(response)) {
    response = await fetchSharekhanNodeHttp(url, {
      method: "POST",
      headers: buildSharekhanHeaders({
        apiKey: resolvedApiKey,
        accessToken: resolvedAccessToken,
      }),
      body: JSON.stringify(requestBody),
    });
  }

  const orderIdRaw =
    response.payload?.data?.orderId ||
    response.payload?.data?.orderid ||
    response.payload?.orderId ||
    response.payload?.orderid ||
    "";
  const orderId = orderIdRaw != null && String(orderIdRaw).trim() !== "" ? String(orderIdRaw).trim() : "";
  const apiErrorMsg = normalizeString(
    response.payload?.data?.errormsg ||
      response.payload?.data?.errorMsg ||
      response.payload?.errormsg ||
      response.payload?.message ||
      response.payload?.error
  );
  // Sharekhan often returns HTTP 200 with orderId "0" + errormsg on rejection.
  const rejectedByBroker =
    Boolean(apiErrorMsg) &&
    (!orderId || orderId === "0") &&
    !/success|order placed|accepted/i.test(apiErrorMsg);
  const ok = Boolean(response.ok) && !rejectedByBroker;

  return {
    ok,
    dryRun: false,
    broker: "sharekhan",
    status: response.status,
    orderId: orderId && orderId !== "0" ? orderId : "",
    request: requestBody,
    instrument: {
      token: instrument.token,
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      instrumentType: instrument.instrumentType,
    },
    result: response,
    error: ok ? null : apiErrorMsg || extractErrorMessage(response.payload, response.status),
    errorDetails: ok
      ? null
      : {
          status: response.status,
          message: apiErrorMsg || extractErrorMessage(response.payload, response.status),
          payload: sanitizeSharekhanPayload(response.payload),
        },
  };
}

function buildSharekhanLoginUrl({ apiKey, state = "12345", vendorKey = "", versionId = "" }) {
  const key = normalizeString(apiKey);
  if (!key) return "";
  const params = new URLSearchParams({
    api_key: key,
    state: normalizeString(state) || "12345",
  });
  if (normalizeString(vendorKey)) params.set("vendor_key", normalizeString(vendorKey));
  if (normalizeString(versionId)) params.set("version_id", normalizeString(versionId));
  return `${DEFAULT_BASE_URL}${LOGIN_PATH}?${params.toString()}`;
}

function decodeSharekhanBase64(value, encoding = "base64") {
  const normalized = normalizeString(value).replace(/ /g, "+");
  if (encoding === "base64url") {
    return Buffer.from(normalized, "base64url");
  }
  const raw = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  return Buffer.from(raw + pad, "base64");
}

function normalizeSharekhanSecureKey(value) {
  // Portal copy/paste often adds quotes, spaces, or zero-width chars.
  return normalizeString(value)
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "");
}

function normalizeSharekhanRequestToken(value) {
  // Query strings often turn "+" into spaces before we see the token.
  let token = normalizeString(value).replace(/ /g, "+");
  try {
    // Only decode if it still looks percent-encoded.
    if (/%[0-9A-Fa-f]{2}/.test(token)) {
      token = decodeURIComponent(token);
    }
  } catch {
    // keep current token
  }
  return normalizeString(token).replace(/ /g, "+");
}

function assertSharekhanSecureKey(secureKey) {
  const key = Buffer.from(normalizeSharekhanSecureKey(secureKey), "utf8");
  if (key.length !== 32) {
    throw new Error(
      `Sharekhan Secure Key must be exactly 32 characters (got ${key.length}). Copy the Secret/Secure Key from the same API app as the API Key.`
    );
  }
  return key;
}

/**
 * Official Sharekhan Node SDK style (shareconnectnodejs AESbase64):
 * decrypt with update() only — do NOT setAuthTag/final (their SDK never verifies the tag).
 */
function decryptSharekhanRequestTokenSdk(requestToken, secureKey, encoding = "base64") {
  const key = assertSharekhanSecureKey(secureKey);
  const token = normalizeSharekhanRequestToken(requestToken);
  const decBytes = decodeSharekhanBase64(token, encoding);
  if (decBytes.length <= 16) {
    throw new Error("Invalid Sharekhan request token");
  }
  const ciphertext = decBytes.subarray(0, decBytes.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ZERO_IV);
  // Match official SDK: update only, no auth-tag verification.
  return decipher.update(ciphertext).toString("utf8");
}

function decryptSharekhanRequestTokenVerified(requestToken, secureKey, encoding = "base64") {
  const key = assertSharekhanSecureKey(secureKey);
  const encrypted = decodeSharekhanBase64(normalizeSharekhanRequestToken(requestToken), encoding);
  if (encrypted.length <= 16) {
    throw new Error("Invalid Sharekhan request token");
  }
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const authTag = encrypted.subarray(encrypted.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ZERO_IV);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function looksLikeSharekhanPayload(text) {
  const value = String(text || "");
  if (!value.includes("|")) return false;
  // Reject obvious binary garbage from a wrong key + update()-only decrypt.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return false;
  const parts = value.split("|");
  return parts.length >= 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0;
}

function decryptSharekhanRequestToken(requestToken, secureKey) {
  const attempts = [
    () => decryptSharekhanRequestTokenSdk(requestToken, secureKey, "base64"),
    () => decryptSharekhanRequestTokenSdk(requestToken, secureKey, "base64url"),
    () => decryptSharekhanRequestTokenVerified(requestToken, secureKey, "base64"),
    () => decryptSharekhanRequestTokenVerified(requestToken, secureKey, "base64url"),
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const decrypted = attempt();
      if (looksLikeSharekhanPayload(decrypted)) {
        return decrypted;
      }
      lastError = new Error("Sharekhan request token decrypt failed (unexpected payload)");
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    lastError?.message?.includes("32 characters")
      ? lastError.message
      : "Could not decrypt Sharekhan request token. Recheck Secure Key (must be the 32-char Secret Key from the same Sharekhan API app as this API Key), then login again."
  );
}

function encryptSharekhanSessionToken(plaintext, secureKey, asBase64Url = false) {
  const key = assertSharekhanSecureKey(secureKey);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ZERO_IV);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);
  return asBase64Url ? combined.toString("base64url") : combined.toString("base64");
}

function extractSharekhanIdsFromDecrypted(decrypted) {
  const parts = String(decrypted || "")
    .split("|")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return { customerId: parts[0] || "", requestId: "" };
  }
  // Token payload is requestId|customerId (or the reverse). Prefer the numeric part as customerId.
  const numeric = parts.find((part) => /^\d+$/.test(part)) || "";
  const other = parts.find((part) => part !== numeric) || parts[0] || "";
  return {
    customerId: numeric || parts[1] || parts[0] || "",
    requestId: other,
  };
}

function buildEncryptedRequestToken(requestToken, secureKey) {
  const decrypted = decryptSharekhanRequestToken(requestToken, secureKey);
  const parts = String(decrypted || "").split("|");
  if (parts.length < 2) {
    throw new Error("Sharekhan request token decrypt failed (unexpected payload)");
  }
  const swapped = `${parts[1]}|${parts[0]}`;
  // Without version_id Sharekhan expects standard base64 (official AESbase64).
  return {
    encryptedRequestToken: encryptSharekhanSessionToken(swapped, secureKey, false),
    ...extractSharekhanIdsFromDecrypted(decrypted),
  };
}

async function exchangeSharekhanAccessToken({
  apiKey,
  secureKey,
  requestToken,
  state = "12345",
  vendorKey = "",
  versionId = "",
}) {
  const resolvedApiKey = normalizeString(apiKey);
  const resolvedSecureKey = normalizeSharekhanSecureKey(secureKey);
  const resolvedRequestToken = normalizeSharekhanRequestToken(requestToken);

  if (!resolvedApiKey || !resolvedSecureKey || !resolvedRequestToken) {
    return {
      ok: false,
      error: "Sharekhan API Key, Secure Key, and request token are required",
    };
  }

  let encryptedRequestToken = "";
  let extractedCustomerId = "";
  try {
    const built = buildEncryptedRequestToken(resolvedRequestToken, resolvedSecureKey);
    encryptedRequestToken = built.encryptedRequestToken;
    extractedCustomerId = normalizeString(built.customerId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to process Sharekhan request token",
    };
  }

  const body = {
    apiKey: resolvedApiKey,
    requestToken: encryptedRequestToken,
    state: normalizeString(state) || "12345",
  };
  if (normalizeString(vendorKey)) body.vendorkey = normalizeString(vendorKey);
  if (normalizeString(versionId)) body.versionId = normalizeString(versionId);

  const url = `${DEFAULT_BASE_URL}${ACCESS_TOKEN_PATH}`;
  const response = await fetchSharekhan(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-type": "application/json",
      "api-key": resolvedApiKey,
    },
    body: JSON.stringify(body),
  });

  const accessToken =
    normalizeString(response.payload?.data?.token) ||
    normalizeString(response.payload?.data?.accessToken) ||
    normalizeString(response.payload?.data?.access_token) ||
    normalizeString(response.payload?.token) ||
    normalizeString(response.payload?.accessToken) ||
    normalizeString(response.payload?.access_token);

  const responseCustomerId =
    normalizeString(response.payload?.data?.customerId) ||
    normalizeString(response.payload?.data?.customer_id) ||
    normalizeString(response.payload?.data?.loginId) ||
    normalizeString(response.payload?.customerId) ||
    extractedCustomerId;

  const ok = Boolean(response.ok) && Boolean(accessToken);
  return {
    ok,
    status: response.status,
    accessToken,
    customerId: responseCustomerId,
    loginUrl: buildSharekhanLoginUrl({ apiKey: resolvedApiKey, state }),
    result: response,
    error: ok ? null : extractErrorMessage(response.payload, response.status),
  };
}

async function getSharekhanDayOrders({ apiKey, accessToken, customerId }) {
  const resolvedApiKey = normalizeString(apiKey);
  const resolvedAccessToken = normalizeString(accessToken);
  const resolvedCustomerId = normalizeString(customerId);
  if (!resolvedApiKey || !resolvedAccessToken || !resolvedCustomerId) {
    return {
      ok: false,
      error: "Sharekhan API Key, Access Token, and Customer ID are required",
    };
  }

  const url = `${DEFAULT_BASE_URL}/skapi/services/reports/${encodeURIComponent(resolvedCustomerId)}`;
  const response = await fetchSharekhan(url, {
    method: "GET",
    headers: buildSharekhanHeaders({
      apiKey: resolvedApiKey,
      accessToken: resolvedAccessToken,
    }),
  });

  const error = response.ok ? null : extractErrorMessage(response.payload, response.status);
  const expired = isSharekhanTokenExpiredError(response.status, error, response.payload);
  const ok = Boolean(response.ok);
  const data =
    response.payload?.data ||
    response.payload?.result ||
    response.payload?.orders ||
    response.payload;

  return {
    ok,
    broker: "sharekhan",
    type: "orders",
    status: response.status,
    expired,
    customerId: resolvedCustomerId,
    orders: Array.isArray(data) ? data : data,
    result: sanitizeSharekhanPayload(response.payload),
    error: ok ? null : error,
  };
}

function isSharekhanTokenExpiredError(status, errorMessage, payload) {
  const code = Number(status);
  if (code === 401 || code === 403) return true;
  const text = [
    errorMessage,
    payload?.message,
    payload?.error,
    payload?.errormsg,
    payload?.data?.errormsg,
    payload?.data?.message,
    typeof payload === "string" ? payload : "",
  ]
    .map((item) => normalizeString(item).toLowerCase())
    .join(" ");
  return /token.*(expir|invalid|unauthor)|expir.*token|session.*(expir|invalid)|unauthori|access.?denied|invalid.?access/.test(
    text
  );
}

async function checkSharekhanSession({ apiKey, accessToken, customerId }) {
  const resolvedApiKey = normalizeString(apiKey);
  const resolvedAccessToken = normalizeString(accessToken);
  const resolvedCustomerId = normalizeString(customerId);

  if (!resolvedApiKey || !resolvedAccessToken) {
    return {
      ok: false,
      connected: false,
      expired: false,
      missing: true,
      error: "Sharekhan API Key and Access Token are required",
    };
  }

  if (!resolvedCustomerId) {
    return {
      ok: false,
      connected: false,
      expired: false,
      missing: true,
      error: "Sharekhan Customer ID is required to verify session",
    };
  }

  const probe = await getSharekhanDayOrders({
    apiKey: resolvedApiKey,
    accessToken: resolvedAccessToken,
    customerId: resolvedCustomerId,
  });

  if (probe.ok) {
    return {
      ok: true,
      connected: true,
      expired: false,
      missing: false,
      status: probe.status,
      customerId: resolvedCustomerId,
      error: null,
    };
  }

  return {
    ok: false,
    connected: false,
    expired: Boolean(probe.expired),
    missing: false,
    status: probe.status,
    customerId: resolvedCustomerId,
    error: probe.error || "Sharekhan session is not valid",
  };
}

async function getSharekhanPositions({ apiKey, accessToken, customerId }) {
  const resolvedApiKey = normalizeString(apiKey);
  const resolvedAccessToken = normalizeString(accessToken);
  const resolvedCustomerId = normalizeString(customerId);
  if (!resolvedApiKey || !resolvedAccessToken || !resolvedCustomerId) {
    return {
      ok: false,
      error: "Sharekhan API Key, Access Token, and Customer ID are required",
    };
  }

  const url = `${DEFAULT_BASE_URL}/skapi/services/trades/${encodeURIComponent(resolvedCustomerId)}`;
  const response = await fetchSharekhan(url, {
    method: "GET",
    headers: buildSharekhanHeaders({
      apiKey: resolvedApiKey,
      accessToken: resolvedAccessToken,
    }),
  });

  const ok = Boolean(response.ok);
  const error = ok ? null : extractErrorMessage(response.payload, response.status);
  const expired = isSharekhanTokenExpiredError(response.status, error, response.payload);
  const data =
    response.payload?.data ||
    response.payload?.result ||
    response.payload?.trades ||
    response.payload;

  return {
    ok,
    broker: "sharekhan",
    type: "positions",
    status: response.status,
    expired,
    customerId: resolvedCustomerId,
    positions: Array.isArray(data) ? data : data,
    result: sanitizeSharekhanPayload(response.payload),
    error,
  };
}

module.exports = {
  placeSharekhanOrder,
  mapCallTypeToTransaction,
  mapExchangeCode,
  buildSharekhanLoginUrl,
  exchangeSharekhanAccessToken,
  getSharekhanDayOrders,
  getSharekhanPositions,
  checkSharekhanSession,
};
