const { SharekhanStream } = require("./sharekhanStream.service");
const { getMarketDataConfig } = require("../models/sharekhanMarketData.model");

let stream = null;
function connectAdminMarketData(config) {
  // Dispose first so token rotation cannot leave multiple active feed sessions.
  const subscriptions = [...(stream?.subscriptions || [])];
  stream?.dispose();
  stream = null;
  if (!config?.enabled || !config.apiKey || !config.accessToken) return;
  stream = new SharekhanStream({ apiKey: config.apiKey, accessToken: config.accessToken });
  subscriptions.forEach((key) => stream.subscriptions.add(key));
  stream.connect();
}
async function startSharekhanMarketData() {
  connectAdminMarketData(await getMarketDataConfig());
}
function marketDataStatus() {
  return {
    connected: Boolean(stream?.ready),
    state: !stream ? "disconnected" : stream.closed ? "error" : stream.ready ? "connected" : "connecting",
    expired: Boolean(stream?.failure?.expired),
    error: stream?.failure?.error || null,
    subscriptions: stream?.subscriptions.size || 0,
    lastTickAt: stream?.lastTickAt || null,
  };
}
async function getSharekhanStreamPrice({ exchange, scripCode }) {
  const result = stream ? await stream.getPrice(exchange, scripCode) : {
    ok: false, error: "Admin Sharekhan price feed is not connected. Login in Admin > Sharekhan Prices.",
  };
  // A market-data expiry must not mark the ordering user's broker token expired.
  const { expired, ...priceResult } = result;
  return { ...priceResult, expired: false, marketDataExpired: Boolean(expired),
    broker: "sharekhan", source: "adminSharekhanWebSocketLtp" };
}
function closeSharekhanStreams() {
  stream?.dispose();
  stream = null;
}
module.exports = { connectAdminMarketData, startSharekhanMarketData, marketDataStatus,
  getSharekhanStreamPrice, closeSharekhanStreams };
