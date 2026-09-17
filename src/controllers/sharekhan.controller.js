const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  placeSharekhanOrder,
  buildSharekhanLoginUrl,
  exchangeSharekhanAccessToken,
} = require("../services/sharekhan.service");
const {
  saveSharekhanLoginPrep,
  getSharekhanLoginPrep,
  saveSharekhanLoginResult,
  takeSharekhanLoginResult,
} = require("../services/sharekhanLoginSession.store");
const { findUserById, updateUserById } = require("../models/user.model");
const { updateStrategyByIdForUser } = require("../models/strategy.model");

function normalizeSecureKey(value) {
  return String(value || "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, "");
}

function buildSharekhanDbPatch({
  apiKey,
  secureKey,
  customerId,
  channelUser,
  accessToken,
  productType,
  connected,
}) {
  const now = new Date().toISOString();
  const patch = {
    "sharekhan.updatedAt": now,
  };
  if (apiKey !== undefined) patch["sharekhan.apiKey"] = String(apiKey || "").trim();
  if (secureKey !== undefined) patch["sharekhan.secureKey"] = normalizeSecureKey(secureKey);
  if (customerId !== undefined) patch["sharekhan.customerId"] = String(customerId || "").trim();
  if (channelUser !== undefined) patch["sharekhan.channelUser"] = String(channelUser || "").trim();
  if (accessToken !== undefined) patch["sharekhan.accessToken"] = String(accessToken || "").trim();
  if (productType !== undefined) patch["sharekhan.productType"] = String(productType || "").trim();
  if (connected !== undefined) {
    patch["sharekhan.connected"] = Boolean(connected);
    if (connected) patch["sharekhan.connectedAt"] = now;
  }
  return patch;
}

async function saveSharekhanDbConfig(userId, values) {
  if (!userId) return null;
  return updateUserById(userId, buildSharekhanDbPatch(values));
}

async function getSharekhanDbConfig(userId) {
  if (!userId) return null;
  const user = await findUserById(userId);
  return user?.sharekhan && typeof user.sharekhan === "object" ? user.sharekhan : null;
}

async function placeSharekhanTrade(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const execute = Boolean(body.execute);
  const result = await placeSharekhanOrder({
    apiKey: body.apiKey || body.sharekhanApiKey,
    accessToken: body.accessToken || body.sharekhanAccessToken,
    customerId: body.customerId || body.sharekhanCustomerId,
    channelUser: body.channelUser || body.sharekhanChannelUser || body.loginId,
    execute,
    exchange: body.exchange,
    segment: body.segment,
    symbol: body.symbol,
    symbolToken: body.symbolToken || body.symboltoken || body.scripCode || body.token,
    callType: body.call_type || body.callType || body.transactionType,
    quantity: body.quantity || body.qty_value || body.qtyValue,
    productType: body.productType || body.producttype || body.sharekhanProductType,
    price: body.price || "0",
    triggerPrice: body.triggerPrice || body.triggerprice || "0",
  });

  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);
}

async function getSharekhanLoginUrl(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const apiKey = String(body.apiKey || body.sharekhanApiKey || "").trim();
  if (!apiKey) {
    throw createHttpError(400, "Sharekhan API Key is required");
  }

  const loginUrl = buildSharekhanLoginUrl({
    apiKey,
    state: body.state || "12345",
    vendorKey: body.vendorKey || "",
    versionId: body.versionId || "",
  });

  sendJson(res, 200, { ok: true, loginUrl });
}

async function saveSharekhanLoginSession(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const apiKey = String(body.apiKey || body.sharekhanApiKey || "").trim();
  const secureKey = normalizeSecureKey(body.secureKey || body.sharekhanSecureKey || body.secretKey);
  const customerId = String(body.customerId || body.sharekhanCustomerId || "").trim();
  const channelUser = String(body.channelUser || body.sharekhanChannelUser || body.loginId || "").trim();
  const productType = String(body.productType || body.sharekhanProductType || "").trim();
  const mode = body.mode === "edit" ? "edit" : "add";
  const strategyId = String(body.strategyId || "").trim();
  const returnTo = String(body.returnTo || "/strategy").trim() || "/strategy";
  const formDraft = body.formDraft && typeof body.formDraft === "object" ? body.formDraft : null;

  if (!apiKey || !secureKey) {
    throw createHttpError(400, "Sharekhan API Key and Secure Key are required");
  }

  saveSharekhanLoginPrep(userId, {
    apiKey,
    secureKey,
    customerId,
    channelUser,
    productType,
    mode,
    strategyId,
    returnTo,
    formDraft,
  });
  await saveSharekhanDbConfig(userId, {
    apiKey,
    secureKey,
    customerId,
    channelUser,
    productType,
    accessToken: body.accessToken || body.sharekhanAccessToken || undefined,
    connected: Boolean(body.accessToken || body.sharekhanAccessToken),
  });

  sendJson(res, 200, { ok: true });
}

async function getSharekhanLoginSession(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const prep = getSharekhanLoginPrep(userId);
  const saved = await getSharekhanDbConfig(userId);
  const merged = prep || saved
    ? {
        ...(saved || {}),
        ...(prep || {}),
      }
    : null;
  sendJson(res, 200, {
    ok: true,
    prep: merged
      ? {
          apiKey: merged.apiKey || "",
          secureKey: merged.secureKey || "",
          customerId: merged.customerId || "",
          channelUser: merged.channelUser || "",
          accessToken: merged.accessToken || "",
          productType: merged.productType || "",
          connected: Boolean(merged.connected || merged.accessToken),
          mode: merged.mode || "add",
          strategyId: merged.strategyId || "",
          returnTo: merged.returnTo || "/strategy",
          formDraft: merged.formDraft || null,
          hasSecureKey: Boolean(merged.secureKey),
          hasAccessToken: Boolean(merged.accessToken),
          hasFormDraft: Boolean(merged.formDraft),
        }
      : null,
  });
}

async function exchangeSharekhanToken(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const result = await exchangeSharekhanAccessToken({
    apiKey: body.apiKey || body.sharekhanApiKey,
    secureKey: body.secureKey || body.sharekhanSecureKey || body.secretKey,
    requestToken: body.requestToken || body.request_token || body.token,
    state: body.state || "12345",
    vendorKey: body.vendorKey || "",
    versionId: body.versionId || "",
  });

  if (!result.ok) {
    throw createHttpError(400, result.error || "Failed to generate Sharekhan access token");
  }

  sendJson(res, 200, result);
}

async function completeSharekhanLogin(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const requestToken = String(body.requestToken || body.request_token || body.token || "").trim();
  if (!requestToken) {
    throw createHttpError(400, "Sharekhan request token is required");
  }

  const prep = getSharekhanLoginPrep(userId);
  const saved = await getSharekhanDbConfig(userId);
  const apiKey = String(body.apiKey || body.sharekhanApiKey || prep?.apiKey || saved?.apiKey || "").trim();
  const secureKey = String(
    body.secureKey ||
      body.sharekhanSecureKey ||
      body.secretKey ||
      prep?.secureKey ||
      saved?.secureKey ||
      ""
  ).trim();
  const customerId = String(
    body.customerId || body.sharekhanCustomerId || prep?.customerId || saved?.customerId || ""
  ).trim();
  const channelUser = String(
    body.channelUser ||
      body.sharekhanChannelUser ||
      body.loginId ||
      prep?.channelUser ||
      saved?.channelUser ||
      ""
  ).trim();
  const productType = String(
    body.productType || body.sharekhanProductType || prep?.productType || saved?.productType || ""
  ).trim();
  const mode = body.mode === "edit" || prep?.mode === "edit" ? "edit" : "add";
  const strategyId = String(body.strategyId || prep?.strategyId || "").trim();
  const returnTo = String(body.returnTo || prep?.returnTo || "/strategy").trim() || "/strategy";
  const formDraft =
    (body.formDraft && typeof body.formDraft === "object" ? body.formDraft : null) ||
    prep?.formDraft ||
    null;

  if (!apiKey || !secureKey) {
    throw createHttpError(
      400,
      "Login session expired. Open Strategy, enter API Key + Secure Key, then login again."
    );
  }

  // Refresh prep so a retry keeps the latest keys/draft.
  saveSharekhanLoginPrep(userId, {
    apiKey,
    secureKey,
    customerId,
    channelUser,
    productType,
    mode,
    strategyId,
    returnTo,
    formDraft,
  });
  await saveSharekhanDbConfig(userId, {
    apiKey,
    secureKey,
    customerId,
    channelUser,
    productType,
    connected: false,
  });

  const exchanged = await exchangeSharekhanAccessToken({
    apiKey,
    secureKey,
    requestToken,
    state: body.state || "12345",
    vendorKey: body.vendorKey || "",
    versionId: body.versionId || "",
  });

  if (!exchanged.ok || !exchanged.accessToken) {
    const failResult = {
      ok: false,
      accessToken: "",
      apiKey,
      secureKey,
      customerId,
      channelUser,
      productType,
      mode,
      strategyId,
      returnTo,
      formDraft,
      connected: false,
      error: exchanged.error || "Failed to generate Sharekhan access token",
      at: Date.now(),
    };
    saveSharekhanLoginResult(userId, failResult);
    await saveSharekhanDbConfig(userId, {
      apiKey,
      secureKey,
      customerId,
      channelUser,
      productType,
      connected: false,
    });
    throw createHttpError(400, failResult.error);
  }

  const resolvedCustomerId = String(exchanged.customerId || customerId || "").trim();
  const result = {
    ok: true,
    accessToken: exchanged.accessToken,
    apiKey,
    secureKey,
    customerId: resolvedCustomerId,
    channelUser,
    productType,
    mode,
    strategyId,
    returnTo,
    formDraft,
    connected: true,
    at: Date.now(),
  };

  saveSharekhanLoginResult(userId, result);
  await saveSharekhanDbConfig(userId, {
    apiKey,
    secureKey,
    customerId: resolvedCustomerId,
    channelUser,
    productType,
    accessToken: exchanged.accessToken,
    connected: true,
  });
  if (mode === "edit" && strategyId) {
    await updateStrategyByIdForUser(userId, strategyId, {
      "marketMaya.sharekhanDirect": true,
      "marketMaya.sharekhanApiKey": apiKey,
      "marketMaya.sharekhanSecureKey": secureKey,
      "marketMaya.sharekhanCustomerId": resolvedCustomerId,
      ...(channelUser ? { "marketMaya.sharekhanChannelUser": channelUser } : {}),
      "marketMaya.sharekhanAccessToken": exchanged.accessToken,
      ...(productType ? { "marketMaya.sharekhanProductType": productType } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
  sendJson(res, 200, result);
}

async function consumeSharekhanLoginResult(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const result = takeSharekhanLoginResult(userId);
  sendJson(res, 200, { ok: true, result: result || null });
}

module.exports = {
  placeSharekhanTrade,
  getSharekhanLoginUrl,
  saveSharekhanLoginSession,
  getSharekhanLoginSession,
  exchangeSharekhanToken,
  completeSharekhanLogin,
  consumeSharekhanLoginResult,
};
