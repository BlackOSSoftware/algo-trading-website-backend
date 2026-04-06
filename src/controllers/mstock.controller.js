const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { getGlobalMStockConfig, upsertGlobalMStockConfig } = require("../models/mstockConfig.model");
const {
  typeBConnectLogin,
  typeBSessionToken,
  typeBVerifyTotp,
  normalizeInterval,
  testMStockMarketData,
} = require("../services/mstock.service");

const ALLOWED_EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO", "CDS", "MCX"]);

function normalizeString(value) {
  return String(value || "").trim();
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

function supportsTypeBEqAutoResolve(doc) {
  const apiType = normalizeString(doc?.apiType).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const exchange = normalizeString(doc?.exchange).toUpperCase();
  return apiType === "typeb" && (exchange === "NSE" || exchange === "BSE");
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

function getJwtExpiryIso(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return "";
  return new Date(exp * 1000).toISOString();
}

function readFirst(body, keys) {
  for (const key of keys) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      const value = body[key];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function buildSavedDefaultsSummary(doc) {
  if (!doc || typeof doc !== "object") {
    return {
      configured: false,
    };
  }

  const apiKeyConfigured = Boolean(normalizeString(doc.apiKey));
  const authTokenConfigured = Boolean(normalizeString(doc.authToken));
  const authTokenExpiresAt = getJwtExpiryIso(doc.authToken);
  const authTokenExpired = Boolean(
    authTokenExpiresAt && new Date(authTokenExpiresAt).getTime() <= Date.now()
  );
  const manualInstrumentTokenConfigured = hasUsableInstrumentToken(doc.instrumentToken);
  const typeBEqAutoResolveReady = Boolean(
    apiKeyConfigured &&
      authTokenConfigured &&
      !authTokenExpired &&
      normalizeString(doc.exchange) &&
      normalizeString(doc.interval) &&
      supportsTypeBEqAutoResolve(doc)
  );

  return {
    hasAnySavedDefaults: Boolean(
      doc.apiKey ||
        doc.authToken ||
        doc.clientCode ||
        doc.state ||
        doc.exchange ||
        doc.interval ||
        doc.instrumentToken ||
        doc.candleOffset !== undefined
    ),
    configured: Boolean(apiKeyConfigured && authTokenConfigured),
    candleReady: Boolean(
      apiKeyConfigured &&
        authTokenConfigured &&
        !authTokenExpired &&
        normalizeString(doc.exchange) &&
        normalizeString(doc.interval) &&
        (manualInstrumentTokenConfigured || typeBEqAutoResolveReady)
    ),
    apiKeyConfigured,
    authTokenConfigured,
    authTokenExpired,
    authTokenExpiresAt: authTokenExpiresAt || "",
    apiType: normalizeString(doc.apiType),
    clientCode: normalizeString(doc.clientCode),
    state: normalizeString(doc.state),
    exchange: normalizeString(doc.exchange),
    interval: normalizeString(doc.interval),
    instrumentToken: normalizeString(doc.instrumentToken),
    instrumentTokenConfigured: manualInstrumentTokenConfigured,
    typeBEqAutoResolveReady,
    candleOffset: doc.candleOffset ?? null,
    updatedAt: normalizeString(doc.updatedAt),
  };
}

function buildSavedConfig(doc) {
  if (!doc || typeof doc !== "object") return null;

  return {
    apiType: normalizeString(doc.apiType),
    apiKey: normalizeString(doc.apiKey),
    authToken: normalizeString(doc.authToken),
    refreshToken: normalizeString(doc.refreshToken),
    feedToken: normalizeString(doc.feedToken),
    clientCode: normalizeString(doc.clientCode),
    state: normalizeString(doc.state),
    exchange: normalizeString(doc.exchange),
    interval: normalizeString(doc.interval),
    instrumentToken: normalizeString(doc.instrumentToken),
    candleOffset:
      doc.candleOffset === undefined || doc.candleOffset === null ? null : Number(doc.candleOffset),
  };
}

function parseCandleDefaultsFromBody(body) {
  const exchange = normalizeString(readFirst(body, ["exchange"])).toUpperCase();
  const intervalInput = normalizeString(readFirst(body, ["interval", "mStockInterval"]));
  const interval = intervalInput ? normalizeInterval(intervalInput) : "";
  const instrumentToken = normalizeString(
    readFirst(body, [
      "instrumentToken",
      "mStockInstrumentToken",
      "symboltoken",
      "symbolToken",
    ])
  );
  const candleOffsetRaw = readFirst(body, ["candleOffset", "mStockCandleOffset"]);
  const candleOffset =
    candleOffsetRaw === undefined || candleOffsetRaw === null || candleOffsetRaw === ""
      ? null
      : Number(candleOffsetRaw);

  if (exchange && !ALLOWED_EXCHANGES.has(exchange)) {
    throw createHttpError(400, "exchange must be NSE, BSE, NFO, BFO, CDS, or MCX");
  }
  if (intervalInput && !interval) {
    throw createHttpError(
      400,
      "interval must be minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute, or day"
    );
  }
  if (instrumentToken && !hasUsableInstrumentToken(instrumentToken)) {
    throw createHttpError(
      400,
      "instrumentToken looks invalid. Enter the real instrument token / symboltoken, not placeholder text like A, B, Type A, Type B, or symboltoken."
    );
  }
  if (candleOffset !== null) {
    if (!Number.isFinite(candleOffset) || candleOffset <= 0) {
      throw createHttpError(400, "candleOffset must be a positive whole number");
    }
  }

  return {
    ...(exchange ? { exchange } : {}),
    ...(interval ? { interval } : {}),
    ...(instrumentToken ? { instrumentToken } : {}),
    ...(candleOffset !== null ? { candleOffset: Math.floor(candleOffset) } : {}),
  };
}

async function persistSessionDefaults({
  adminId,
  apiKey,
  clientCode,
  state,
  session,
  candleDefaults = {},
}) {
  const patch = {
    apiType: "typeB",
    ...(normalizeString(apiKey) ? { apiKey: normalizeString(apiKey) } : {}),
    ...(normalizeString(clientCode || session?.clientCode)
      ? { clientCode: normalizeString(clientCode || session?.clientCode) }
      : {}),
    ...(normalizeString(state || session?.state)
      ? { state: normalizeString(state || session?.state) }
      : {}),
    ...(normalizeString(session?.jwtToken) ? { authToken: normalizeString(session.jwtToken) } : {}),
    ...(normalizeString(session?.refreshToken)
      ? { refreshToken: normalizeString(session.refreshToken) }
      : {}),
    ...(normalizeString(session?.feedToken) ? { feedToken: normalizeString(session.feedToken) } : {}),
    ...candleDefaults,
    ...(!hasUsableInstrumentToken(candleDefaults.instrumentToken) ? { instrumentToken: "" } : {}),
    ...(adminId ? { updatedByAdminId: String(adminId) } : {}),
  };

  if (Object.keys(patch).length === 0) {
    return null;
  }

  return upsertGlobalMStockConfig(patch);
}

async function typeBLoginAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const existingDefaults = (await getGlobalMStockConfig().catch(() => null)) || {};
  const clientCode = normalizeString(readFirst(body, ["clientCode", "clientcode", "client_code"]));
  const password = normalizeString(readFirst(body, ["password"]));
  const apiKey = normalizeString(readFirst(body, ["apiKey", "api_key"])) || normalizeString(existingDefaults.apiKey);
  const state = normalizeString(readFirst(body, ["state"]));
  const totp = normalizeString(readFirst(body, ["totp"]));
  const candleDefaults = parseCandleDefaultsFromBody(body);

  if (!clientCode) {
    throw createHttpError(400, "clientCode is required");
  }
  if (!password) {
    throw createHttpError(400, "password is required");
  }

  const result = await typeBConnectLogin({ clientCode, password, state, apiKey, totp });
  let savedDefaults = null;
  let savedConfig = null;
  if (result.ok) {
    const saved = await upsertGlobalMStockConfig({
      apiType: "typeB",
      ...(normalizeString(apiKey) ? { apiKey: normalizeString(apiKey) } : {}),
      ...(normalizeString(clientCode) ? { clientCode: normalizeString(clientCode) } : {}),
      ...(normalizeString(state) ? { state: normalizeString(state) } : {}),
      ...(normalizeString(result.session?.refreshToken)
        ? { refreshToken: normalizeString(result.session.refreshToken) }
        : {}),
      authToken: "",
      feedToken: "",
      ...candleDefaults,
      ...(!hasUsableInstrumentToken(candleDefaults.instrumentToken)
        ? { instrumentToken: "" }
        : {}),
      updatedByAdminId: String(adminId),
    });
    savedDefaults = buildSavedDefaultsSummary(saved);
    savedConfig = buildSavedConfig(saved);
  }
  sendJson(res, 200, {
    ...result,
    ...(savedDefaults ? { savedDefaults } : {}),
    ...(savedConfig ? { savedConfig } : {}),
  });
}

async function typeBSessionTokenAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const existingDefaults = (await getGlobalMStockConfig().catch(() => null)) || {};
  const apiKey = normalizeString(readFirst(body, ["apiKey", "api_key"])) || normalizeString(existingDefaults.apiKey);
  const refreshToken = normalizeString(
    readFirst(body, ["refreshToken", "refresh_token"])
  );
  const otp = normalizeString(readFirst(body, ["otp"]));
  const candleDefaults = parseCandleDefaultsFromBody(body);

  if (!apiKey) {
    throw createHttpError(400, "apiKey is required");
  }
  if (!refreshToken) {
    throw createHttpError(400, "refreshToken is required");
  }
  if (!otp) {
    throw createHttpError(400, "otp is required");
  }

  const result = await typeBSessionToken({ apiKey, refreshToken, otp });
  let savedDefaults = null;
  let savedConfig = null;
  if (result.ok && result.session) {
    const existing = (await getGlobalMStockConfig().catch(() => null)) || {};
    const saved = await persistSessionDefaults({
      adminId,
      apiKey,
      clientCode: existing.clientCode,
      state: existing.state,
      session: result.session,
      candleDefaults,
    });
    savedDefaults = buildSavedDefaultsSummary(saved);
    savedConfig = buildSavedConfig(saved);
  }
  sendJson(res, 200, {
    ...result,
    ...(savedDefaults ? { savedDefaults } : {}),
    ...(savedConfig ? { savedConfig } : {}),
  });
}

async function typeBVerifyTotpAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const existingDefaults = (await getGlobalMStockConfig().catch(() => null)) || {};
  const apiKey = normalizeString(readFirst(body, ["apiKey", "api_key"])) || normalizeString(existingDefaults.apiKey);
  const refreshToken = normalizeString(
    readFirst(body, ["refreshToken", "refresh_token"])
  );
  const totp = normalizeString(readFirst(body, ["totp"]));
  const candleDefaults = parseCandleDefaultsFromBody(body);

  if (!apiKey) {
    throw createHttpError(400, "apiKey is required");
  }
  if (!refreshToken) {
    throw createHttpError(400, "refreshToken is required");
  }
  if (!totp) {
    throw createHttpError(400, "totp is required");
  }

  const result = await typeBVerifyTotp({ apiKey, refreshToken, totp });
  let savedDefaults = null;
  let savedConfig = null;
  if (result.ok && result.session) {
    const existing = (await getGlobalMStockConfig().catch(() => null)) || {};
    const saved = await persistSessionDefaults({
      adminId,
      apiKey,
      clientCode: existing.clientCode,
      state: existing.state,
      session: result.session,
      candleDefaults,
    });
    savedDefaults = buildSavedDefaultsSummary(saved);
    savedConfig = buildSavedConfig(saved);
  }
  sendJson(res, 200, {
    ...result,
    ...(savedDefaults ? { savedDefaults } : {}),
    ...(savedConfig ? { savedConfig } : {}),
  });
}

async function getSavedDefaultsAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const saved = await getGlobalMStockConfig().catch(() => null);
  sendJson(res, 200, {
    ok: true,
    savedDefaults: buildSavedDefaultsSummary(saved),
    savedConfig: buildSavedConfig(saved),
  });
}

async function testMarketDataAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const symbol = normalizeString(readFirst(body, ["symbol"])) || "ONGC";
  const segment = normalizeString(readFirst(body, ["segment"])) || "EQ";
  const exchange = normalizeString(readFirst(body, ["exchange"])).toUpperCase();
  const interval = normalizeString(readFirst(body, ["interval", "mStockInterval"]));

  const result = await testMStockMarketData({
    symbol,
    segment,
    exchange,
    interval,
  });

  sendJson(res, 200, result);
}

async function updateSavedDefaultsAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const existing = (await getGlobalMStockConfig().catch(() => null)) || {};
  const candleDefaults = parseCandleDefaultsFromBody(body);
  const patch = {
    apiType: normalizeString(existing.apiType) || "typeB",
    ...candleDefaults,
    ...(!hasUsableInstrumentToken(candleDefaults.instrumentToken) ? { instrumentToken: "" } : {}),
    updatedByAdminId: String(adminId),
  };

  const saved = await upsertGlobalMStockConfig(patch);
  sendJson(res, 200, {
    ok: true,
    message: "mStock candle defaults saved",
    savedDefaults: buildSavedDefaultsSummary(saved),
    savedConfig: buildSavedConfig(saved),
  });
}

module.exports = {
  typeBLoginAdmin,
  typeBSessionTokenAdmin,
  typeBVerifyTotpAdmin,
  getSavedDefaultsAdmin,
  testMarketDataAdmin,
  updateSavedDefaultsAdmin,
};
