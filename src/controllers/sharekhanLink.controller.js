const crypto = require("crypto");
const QRCode = require("qrcode");
const { getDb } = require("../config/db");
const { resolveInstrumentForOrder } = require("../models/mstockInstrument.model");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");

const collection = () => getDb().collection("sharekhan_links");
const SHAREKHAN_TRADING_HOME = "https://newtrade.sharekhan.com/";

function parsePayload(input) {
  const value = String(input || "").trim();
  let payload = value;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw createHttpError(400, "Invalid Sharekhan URL"); }
    if (url.protocol !== "https:" || url.hostname !== "downloads.sharekhan.com" || url.pathname !== "/download/sharemobile/onetap.html") {
      throw createHttpError(400, "Only Sharekhan's official one-tap URL is accepted");
    }
    payload = url.searchParams.get("deepLinking") || "";
  }
  payload = payload.replace(/%24/gi, "$");
  if (!/^\d+(?:\$[\d.]*){0,30}$/.test(payload) || payload.length > 300) {
    throw createHttpError(400, "Enter a verified numeric $-separated deepLinking payload");
  }
  return payload;
}

function webTradeUrl(details) {
  const exchange = String(details?.exchange || "").trim().toUpperCase();
  const symbol = encodeURIComponent(String(details?.tradingSymbol || "").trim().toUpperCase());
  const scripCode = String(details?.scripCode || "").trim();
  if (!symbol || !scripCode || !["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange)) return SHAREKHAN_TRADING_HOME;
  return `https://newtrade.sharekhan.com/skweb/trading/tradenow/normal/${exchange}/${symbol}/${scripCode}`;
}

// Pehle downloads.sharekhan.com/onetap.html app kholta tha; us host ka SSL ab expire hai.
// Wahi onetap.js Android/iOS pe Adjust + splashscheme:// se app kholta hai — hum seedha wahi URL use karte hain (webpage nahi).
function mobileAppUrls(payload) {
  const deep = String(payload || "").trim();
  if (!deep) return { android: "", ios: "", scheme: "" };
  // Exact Sharekhan onetap.js format: prefix encoded, payload appended raw (with $).
  return {
    android: `https://app.adjust.net.in/tp42jlw?label=ADJUST_DEEP_LINK&deeplink=splashscheme%3A%2F%2FDEEPLINK%3D${deep}`,
    ios: `https://v6yk.adj.st/102%2411%2422?adj_t=1t1b59tm&adj_deep_link=splashscheme%3A%2F%2F${deep}`,
    scheme: `splashscheme://DEEPLINK=${deep}`,
  };
}

function pickMobileAppUrl(payload, userAgent) {
  const urls = mobileAppUrls(payload);
  if (!urls.android && !urls.ios) return "";
  const ua = String(userAgent || "").toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return urls.ios || urls.android;
  return urls.android || urls.ios;
}

function publicApiBase() {
  return (process.env.PUBLIC_API_URL || "https://api.emotionlesstraders.com").replace(/\/$/, "");
}

// Same shape as pehle (…?deepLinking=131$…) so the order page auto-opens on phone,
// but hosted on our API (valid SSL) and redirected to Sharekhan's Adjust app link — never the website.
function ourOnetapUrl(payload) {
  const deep = String(payload || "").trim();
  if (!deep) return "";
  return `${publicApiBase()}/sk-onetap?deepLinking=${deep}`;
}

function onetapUrl(payload, _details, userAgent) {
  // Prefer our deepLinking URL (works with old frontend auto-open). Fall back to Adjust.
  return ourOnetapUrl(payload) || pickMobileAppUrl(payload, userAgent) || "";
}

async function skOnetapRedirect(req, res) {
  const raw = String(req.parsedUrl?.searchParams?.get("deepLinking") || "").trim();
  const payload = raw.replace(/%24/gi, "$");
  if (!/^\d+(?:\$[\d.]*){0,30}$/.test(payload) || payload.length > 300) {
    throw createHttpError(400, "Invalid Sharekhan deepLinking payload");
  }
  const location = pickMobileAppUrl(payload, req.headers?.["user-agent"] || "");
  if (!location) throw createHttpError(404, "Sharekhan app link unavailable");
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

// Matches Sharekhan's own link format: 131$<exchange>$<scrip>$<side>$<price>$<qty>, NSE = 11, empty price = market.
function buildOrderDeepLink({ exchange, scripCode, side, price, quantity }) {
  const exchangeCode = exchange === "BSE" ? "12" : "11";
  const sideCode = side === "SELL" ? "2" : "1";
  const numericPrice = Number(price);
  const priceCode = Number.isFinite(numericPrice) && numericPrice > 0 ? String(numericPrice) : "";
  return ["131", exchangeCode, String(scripCode), sideCode, priceCode, String(quantity)].join("$");
}

function intentPayload(record) {
  const details = record?.details || {};
  if (record?.kind !== "order-intent" || !/^[1-9]\d{0,12}$/.test(String(details.scripCode || ""))) {
    return record?.payload || "";
  }
  return buildOrderDeepLink({
    exchange: details.exchange,
    scripCode: details.scripCode,
    side: details.side,
    price: details.price,
    quantity: details.quantity,
  });
}

function publicRecord(record, req) {
  const base = (process.env.PUBLIC_API_URL || "https://api.emotionlesstraders.com").replace(/\/$/, "");
  const payload = intentPayload(record);
  const apps = mobileAppUrls(payload);
  if (record.kind === "order-intent") {
    return {
      code: record.code,
      shortUrl: `https://www.emotionlesstraders.com/order/${record.code}`,
      destination: apps.android || apps.ios || "",
      androidAppUrl: apps.android,
      iosAppUrl: apps.ios,
      details: record.details,
      kind: record.kind,
      active: record.active,
      createdAt: record.createdAt,
      clicks: record.clicks || 0,
    };
  }
  return {
    code: record.code,
    shortUrl: `${base}/l/${record.code}`,
    destination: apps.android || onetapUrl(payload, record.details),
    androidAppUrl: apps.android,
    iosAppUrl: apps.ios,
    details: record.details,
    kind: record.kind || "sharekhan-deeplink",
    active: record.active,
    createdAt: record.createdAt,
    clicks: record.clicks || 0,
  };
}

async function createIntent(req, res) {
  const body = await parseBody(req);
  const source = body.details || {};
  const stock = String(source.stock || "").trim().slice(0, 120);
  const tradingSymbol = String(source.tradingSymbol || "").trim().toUpperCase().slice(0, 60);
  const side = String(source.side || "").trim().toUpperCase();
  const exchange = String(source.exchange || "").trim().toUpperCase();
  const segment = String(source.segment || "EQ").trim().toUpperCase();
  const orderType = String(source.orderType || "NORMAL").trim().toUpperCase();
  const productType = String(source.productType || "INVESTMENT").trim().toUpperCase();
  const validity = String(source.validity || "GFD").trim().toUpperCase();
  const triggerPrice = Number(source.triggerPrice || 0);
  const bracket = source.bracket && typeof source.bracket === "object" ? {
    enabled: Boolean(source.bracket.enabled),
    targetPrice: Number(source.bracket.targetPrice || 0),
    stopLossPrice: Number(source.bracket.stopLossPrice || 0),
    trailingStop: Number(source.bracket.trailingStop || 0),
  } : { enabled: false, targetPrice: 0, stopLossPrice: 0, trailingStop: 0 };
  const quantity = Number(source.quantity);
  const price = Number(source.price);
  if (!tradingSymbol || !/^[A-Z0-9._-]+$/.test(tradingSymbol)) throw createHttpError(400, "Valid trading symbol is required");
  if (!["BUY", "SELL"].includes(side)) throw createHttpError(400, "Choose Buy or Sell");
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw createHttpError(400, "Quantity must be a positive whole number");
  if (!Number.isFinite(price) || price < 0) throw createHttpError(400, "Price must be zero or greater");
  if (!["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange)) throw createHttpError(400, "Choose a supported exchange");
  if (!["EQ", "FUT", "OPT"].includes(segment)) throw createHttpError(400, "Choose Equity, Futures, or Options");
  if (segment !== "EQ" && !["NFO", "BFO", "MCX", "CDS"].includes(exchange)) throw createHttpError(400, "Choose a derivatives exchange for Futures or Options");
  if (!["NORMAL", "LIMIT", "STOPLOSS", "STOPLOSS_MARKET"].includes(orderType)) throw createHttpError(400, "Choose a supported Sharekhan order type");
  if (!["INVESTMENT", "BIGTRADE", "BIGTRADEPLUS"].includes(productType)) throw createHttpError(400, "Choose a supported Sharekhan product type");
  if (!["GFD", "IOC"].includes(validity)) throw createHttpError(400, "Choose Day or IOC validity");
  if (orderType !== "NORMAL" && (!Number.isFinite(price) || price <= 0)) throw createHttpError(400, "A positive limit price is required for this order type");
  if (orderType.startsWith("STOPLOSS") && (!Number.isFinite(triggerPrice) || triggerPrice <= 0)) throw createHttpError(400, "A positive trigger price is required for stop-loss orders");
  if (bracket.enabled && (!["NSE", "BSE"].includes(exchange) || segment !== "EQ")) throw createHttpError(400, "Bracket order links are supported here for equity contracts only");
  if (bracket.enabled && (!(bracket.targetPrice > 0) || !(bracket.stopLossPrice > 0) || bracket.targetPrice === bracket.stopLossPrice)) throw createHttpError(400, "Bracket order needs different positive target and stop-loss prices");
  let scripCode = String(source.scripCode || "").trim();
  if (!/^[1-9]\d{0,12}$/.test(scripCode)) {
    const instrument = await resolveInstrumentForOrder({ symbol: tradingSymbol, exchange, segment, symbolToken: source.scripCode });
    scripCode = String(instrument?.token || "");
  }
  if (/^[1-9]\d{0,12}$/.test(scripCode)) {
    const instrument = await resolveInstrumentForOrder({ exchange, segment, symbolToken: scripCode });
    if (!instrument || String(instrument.symbol || "").toUpperCase() !== tradingSymbol) {
      throw createHttpError(400, "Selected instrument does not match the symbol, exchange, and segment");
    }
  }
  if (!/^[1-9]\d{0,12}$/.test(scripCode)) {
    throw createHttpError(400, "Sharekhan scrip code not found. Enter the scrip code, or sync the script master.");
  }
  const payload = ["NSE", "BSE"].includes(exchange) && segment === "EQ"
    ? buildOrderDeepLink({ exchange, scripCode, side, price, quantity })
    : "";
  const card = source.card && typeof source.card === "object" ? {
    buyRange: String(source.card.buyRange || source.buyRange || price || "").trim().slice(0, 40),
    target: String(source.card.target || source.target || "").trim().slice(0, 40),
    stopLoss: String(source.card.stopLoss || source.stopLoss || "").trim().slice(0, 40),
    timeFrame: String(source.card.timeFrame || source.timeFrame || "").trim().slice(0, 40),
    headline: String(source.card.headline || source.headline || "").trim().slice(0, 60),
  } : {
    buyRange: String(source.buyRange || price || "").trim().slice(0, 40),
    target: String(source.target || "").trim().slice(0, 40),
    stopLoss: String(source.stopLoss || "").trim().slice(0, 40),
    timeFrame: String(source.timeFrame || "").trim().slice(0, 40),
    headline: String(source.headline || "").trim().slice(0, 60),
  };
  const details = { stock, tradingSymbol, side, quantity, price, exchange, segment, scripCode,
    orderType, productType, validity, triggerPrice,
    bracket,
    card,
    notes: String(source.notes || "").trim().slice(0, 500) };
  const record = { code: crypto.randomBytes(12).toString("base64url"), kind: "order-intent", payload, details,
    active: true, clicks: 0, createdAt: new Date(), createdBy: req.user.sub };
  await collection().insertOne(record);
  sendJson(res, 201, { ok: true, link: publicRecord(record, req) });
}

async function getIntent(req, res) {
  const record = await collection().findOne({ code: req.params.code, kind: "order-intent", active: true });
  if (!record) throw createHttpError(404, "Order link not found or inactive");
  await collection().updateOne({ _id: record._id }, { $inc: { clicks: 1 } });
  res.setHeader("Cache-Control", "no-store");
  const payload = intentPayload(record);
  const apps = mobileAppUrls(payload);
  const ua = req.headers?.["user-agent"] || "";
  const appUrl = ourOnetapUrl(payload) || pickMobileAppUrl(payload, ua) || "";
  sendJson(res, 200, {
    ok: true,
    details: record.details,
    payload,
    appUrl,
    androidAppUrl: apps.android,
    iosAppUrl: apps.ios,
    schemeUrl: apps.scheme,
  });
}

async function create(req, res) {
  const body = await parseBody(req);
  const payload = parsePayload(body.payload);
  const allowed = ["stock", "tradingSymbol", "side", "quantity", "price", "exchange", "segment", "scripCode", "expiry", "strike", "optionType", "lotSize", "orderType", "productType", "validity", "triggerPrice", "bracket", "notes"];
  const details = {};
  for (const key of allowed) details[key] = String(body.details?.[key] ?? "").trim().slice(0, 200);
  const record = { code: crypto.randomBytes(9).toString("base64url"), payload, details,
    active: true, clicks: 0, createdAt: new Date(), createdBy: req.user.sub };
  await collection().insertOne(record);
  sendJson(res, 201, { ok: true, link: publicRecord(record, req) });
}

async function list(req, res) {
  const records = await collection().find({}, { projection: { createdBy: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  sendJson(res, 200, { ok: true, links: records.map((record) => publicRecord(record, req)) });
}

async function deactivate(req, res) {
  const result = await collection().updateOne({ code: req.params.code }, { $set: { active: false } });
  if (!result.matchedCount) throw createHttpError(404, "Link not found");
  sendJson(res, 200, { ok: true });
}

function publicOrderUrl(record) {
  if (record?.kind === "order-intent") {
    return `https://www.emotionlesstraders.com/order/${record.code}`;
  }
  const base = publicApiBase();
  return `${base}/l/${record.code}`;
}

async function getLinkQr(req, res) {
  const record = await collection().findOne({ code: req.params.code, active: true });
  if (!record) throw createHttpError(404, "Link not found or inactive");
  const targetUrl = publicOrderUrl(record);
  const png = await QRCode.toBuffer(targetUrl, {
    type: "png",
    width: 512,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#111111", light: "#ffffff" },
  });
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=300",
    "Content-Length": png.length,
  });
  res.end(png);
}

async function redirect(req, res) {
  const record = await collection().findOne({ code: req.params.code, active: true });
  const payload = intentPayload(record);
  if (!record || !payload) throw createHttpError(404, "Link not found or inactive");
  await collection().updateOne({ _id: record._id }, { $inc: { clicks: 1 } });
  const location =
    onetapUrl(payload, record.details, req.headers?.["user-agent"] || "") ||
    `https://www.emotionlesstraders.com/order/${record.code}`;
  if (!location.startsWith("http")) {
    throw createHttpError(404, "Sharekhan app link unavailable for this order");
  }
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

module.exports = {
  create,
  createIntent,
  getIntent,
  list,
  deactivate,
  getLinkQr,
  redirect,
  skOnetapRedirect,
  parsePayload,
  buildOrderDeepLink,
  webTradeUrl,
  mobileAppUrls,
  pickMobileAppUrl,
  ourOnetapUrl,
};
