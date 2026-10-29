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
  // Prefix is percent-encoded; payload `$` stays raw (Sharekhan one-tap parses `$` fields).
  const encodedPrefix = "splashscheme%3A%2F%2FDEEPLINK%3D";
  return {
    android: `https://app.adjust.net.in/tp42jlw?label=ADJUST_DEEP_LINK&deeplink=${encodedPrefix}${deep}`,
    ios: `https://v6yk.adj.st/?adj_t=1t1b59tm&adj_deep_link=${encodedPrefix}${deep}`,
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

// Sharekhan one-tap format (verified against official GOLDETF sample + field tests):
// 131$<exchange>$<scrip>$<qty>$<price>$<side>
// NSE=11, BSE=12, BUY=1, SELL=2, empty price = market.
// Old side$price$qty order made qty show as 1 and side/exchange look flipped in the app.
function buildOrderDeepLink({ exchange, scripCode, side, price, quantity }) {
  const exchangeNorm = String(exchange || "").trim().toUpperCase();
  const sideNorm = String(side || "").trim().toUpperCase();
  const exchangeCode = exchangeNorm === "BSE" ? "12" : "11";
  const sideCode = sideNorm === "SELL" ? "2" : "1";
  const qtyNum = Number(quantity);
  const qtyCode = Number.isFinite(qtyNum) && qtyNum > 0 ? String(Math.trunc(qtyNum)) : "1";
  const numericPrice = Number(price);
  const priceCode = Number.isFinite(numericPrice) && numericPrice > 0 ? String(numericPrice) : "";
  return ["131", exchangeCode, String(scripCode).trim(), qtyCode, priceCode, sideCode].join("$");
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
  if (segment === "EQ" && !["NSE", "BSE"].includes(exchange)) {
    throw createHttpError(400, "Equity orders support NSE and BSE only. Switch segment to Futures/Options for MCX or CDS.");
  }
  if (segment !== "EQ" && ["NSE", "BSE"].includes(exchange)) {
    throw createHttpError(400, "Futures/Options need NFO, BFO, MCX, or CDS. Equity cash uses NSE/BSE.");
  }
  let scripCode = String(source.scripCode || "").trim();
  if (!/^[1-9]\d{0,12}$/.test(scripCode)) {
    const instrument = await resolveInstrumentForOrder({ symbol: tradingSymbol, exchange, segment, symbolToken: source.scripCode });
    scripCode = String(instrument?.token || "");
  }
  if (/^[1-9]\d{0,12}$/.test(scripCode)) {
    const instrument = await resolveInstrumentForOrder({ exchange, segment, symbolToken: scripCode });
    if (!instrument) {
      throw createHttpError(400, "Scrip code not found for this exchange. Search and select the instrument again.");
    }
    const normalizeSym = (value) => String(value || "").trim().toUpperCase().replace(/-(EQ|BE|BL|ZZ)$/i, "");
    const selected = normalizeSym(instrument.symbol);
    const expected = normalizeSym(tradingSymbol);
    const name = normalizeSym(instrument.name);
    const compatible =
      selected === expected ||
      name === expected ||
      selected.startsWith(expected) ||
      expected.startsWith(selected);
    if (!compatible) {
      throw createHttpError(
        400,
        `Instrument mismatch: scrip ${scripCode} is ${instrument.symbol} on ${instrument.exchange}, not ${tradingSymbol} on ${exchange}.`
      );
    }
  }
  if (!/^[1-9]\d{0,12}$/.test(scripCode)) {
    throw createHttpError(400, "Sharekhan scrip code not found. Search and select an instrument, or sync the script master.");
  }
  const payload = ["NSE", "BSE"].includes(exchange) && segment === "EQ"
    ? buildOrderDeepLink({ exchange, scripCode, side, price, quantity })
    : "";
  const target1 = String(source.card?.target1 || source.target1 || source.card?.target || source.target || "").trim().slice(0, 40);
  const target2 = String(source.card?.target2 || source.target2 || "").trim().slice(0, 40);
  const card = {
    buyRange: String(source.card?.buyRange || source.buyRange || price || "").trim().slice(0, 40),
    target1,
    target2,
    target: [target1, target2].filter(Boolean).join(" / ").slice(0, 40),
    stopLoss: String(source.card?.stopLoss || source.stopLoss || "").trim().slice(0, 40),
    timeFrame: String(source.card?.timeFrame || source.timeFrame || "").trim().slice(0, 40),
    headline: String(source.card?.headline || source.headline || "").trim().slice(0, 60),
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

async function remove(req, res) {
  const code = String(req.params.code || "").trim();
  if (!code) throw createHttpError(400, "Link code is required");
  const result = await collection().deleteOne({ code });
  if (!result.deletedCount) throw createHttpError(404, "Link not found");
  sendJson(res, 200, { ok: true, deleted: true, code });
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
  remove,
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
