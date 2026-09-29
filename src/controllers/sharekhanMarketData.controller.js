const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { getMarketDataConfig, saveMarketDataConfig, takeLoginPrep } = require("../models/sharekhanMarketData.model");
const { connectAdminMarketData, marketDataStatus, closeSharekhanStreams } = require("../services/sharekhanMarketData.service");
const { buildSharekhanLoginUrl, exchangeSharekhanAccessToken } = require("../services/sharekhan.service");

async function status(req, res) {
  const config = await getMarketDataConfig();
  sendJson(res, 200, { ok: true, ...marketDataStatus(), enabled: Boolean(config?.enabled),
    hasSavedKeys: Boolean(config?.loginKeys?.apiKey && config?.loginKeys?.secureKey),
    apiKeyHint: config?.loginKeys?.apiKey ? `????${config.loginKeys.apiKey.slice(-4)}` : null,
    tokenStatus: marketDataStatus().expired ? "expired" : marketDataStatus().connected ? "valid" : config?.accessToken ? "unverified" : "missing",
    hasCredentials: Boolean(config?.apiKey && config?.accessToken), updatedAt: config?.updatedAt || null });
}
async function login(req, res) {
  const body = await parseBody(req);
  const saved = await getMarketDataConfig();
  const suppliedApiKey = String(body.apiKey || "").trim();
  const apiKey = suppliedApiKey || saved?.loginKeys?.apiKey || "";
  if (suppliedApiKey && suppliedApiKey !== saved?.loginKeys?.apiKey && !body.secureKey) {
    throw createHttpError(400, "Enter the Secure Key for the new API Key");
  }
  const secureKey = String(body.secureKey || saved?.loginKeys?.secureKey || "").trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, "");
  if (!apiKey || !secureKey) throw createHttpError(400, "API Key and Secure Key are required");
  const state = `admin-feed-${crypto.randomBytes(24).toString("hex")}`;
  await saveMarketDataConfig({ loginKeys: { apiKey, secureKey }, login: { userId: req.user.sub, apiKey, secureKey, state, expiresAt: Date.now() + 10 * 60000 } });
  sendJson(res, 200, { ok: true, state, loginUrl: buildSharekhanLoginUrl({ apiKey, state }) });
}
async function complete(req, res) {
  const body = await parseBody(req);
  const state = String(body.state || "");
  const requestToken = String(body.requestToken || "").trim();
  if (!state || !requestToken) throw createHttpError(400, "Request token and login state are required");
  const config = await takeLoginPrep(req.user.sub, state);
  if (!config?.login) throw createHttpError(400, "Admin login expired or already used. Start Sharekhan login again.");
  const { apiKey, secureKey } = config.login;
  const exchanged = await exchangeSharekhanAccessToken({ apiKey, secureKey, requestToken, state });
  if (!exchanged.ok || !exchanged.accessToken) {
    throw createHttpError(400, "Sharekhan token exchange failed. Check the admin API keys and start login again.");
  }
  const credentials = { apiKey, accessToken: exchanged.accessToken, enabled: true };
  await saveMarketDataConfig(credentials);
  connectAdminMarketData(credentials);
  sendJson(res, 200, { ok: true, ...marketDataStatus() });
}
async function reconnect(req, res) {
  const config = await getMarketDataConfig();
  if (!config?.accessToken) throw createHttpError(400, "Login to Sharekhan first");
  await saveMarketDataConfig({ enabled: true });
  connectAdminMarketData({ ...config, enabled: true });
  sendJson(res, 200, { ok: true, ...marketDataStatus() });
}
async function disconnect(req, res) {
  await saveMarketDataConfig({ enabled: false, login: null });
  closeSharekhanStreams();
  sendJson(res, 200, { ok: true, ...marketDataStatus() });
}
// Keep login completion, token rotation and disconnect ordered within this backend.
let mutation = Promise.resolve();
function serial(handler) {
  return (req, res) => {
    const next = mutation.then(() => handler(req, res));
    mutation = next.catch(() => {});
    return next;
  };
}
module.exports = { status, login: serial(login), complete: serial(complete),
  reconnect: serial(reconnect), disconnect: serial(disconnect) };
