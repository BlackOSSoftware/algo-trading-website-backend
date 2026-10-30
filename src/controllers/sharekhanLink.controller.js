const crypto = require("crypto");
const QRCode = require("qrcode");
const { getDb } = require("../config/db");
const { resolveInstrumentForOrder } = require("../models/mstockInstrument.model");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");

const collection = () => getDb().collection("sharekhan_links");
const SHAREKHAN_TRADING_HOME = "https://newtrade.sharekhan.com/";

function isValidDeepLinkPayload(payload) {
  const value = String(payload || "").trim();
  if (!value || value.length > 500) return false;
  // Single-leg: 131$exchange$scrip$qty$price$side
  if (/^\d+(?:\$[\d.]*){0,30}$/.test(value)) return true;
  // Multi-leg spread (Sharekhan research / basket one-tap):
  // 181$NF-127904-BUY-0-150_NF-103787-SELL-0-150$2826052
  if (/^181\$[A-Za-z0-9._$-]+$/.test(value)) return true;
  return false;
}

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
  if (!isValidDeepLinkPayload(payload)) {
    throw createHttpError(400, "Enter a verified Sharekhan deepLinking payload");
  }
  return payload;
}

function webTradeUrl(details) {
  const exchange = String(details?.exchange || "").trim().toUpperCase();
  const symbol = encodeURIComponent(String(details?.tradingSymbol || "").trim().toUpperCase());
  const scripCode = String(details?.scripCode || "").trim();
  if (!symbol || !scripCode || !["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange)) return SHAREKHAN_TRADING_HOME;
  const mode = details?.bracket?.enabled || String(details?.orderType || "").toUpperCase() === "BRACKET"
    ? "brackettsl"
    : "normal";
  return `https://newtrade.sharekhan.com/skweb/trading/tradenow/${mode}/${exchange}/${symbol}/${scripCode}`;
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
  if (!isValidDeepLinkPayload(payload)) {
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
// Equity: NSE=11, BSE=12. F&O ids from Sharekhan app mobile_config (ez_options):
// NFO=12, BFO=22, MCX=32. CDS best-effort=13.
// BUY=1, SELL=2, empty price = market.
// Bracket/BigTrade+ SL+target are NOT in the public one-tap schema — entry fields only.
// Extra trailing fields have broken parsing before, so we keep the proven 6-field payload.
function exchangeCodeForDeepLink(exchange) {
  const exchangeNorm = String(exchange || "").trim().toUpperCase();
  if (exchangeNorm === "BSE") return "12";
  if (exchangeNorm === "NFO") return "12";
  if (exchangeNorm === "BFO") return "22";
  if (exchangeNorm === "MCX") return "32";
  if (exchangeNorm === "CDS") return "13";
  return "11"; // NSE cash
}

function buildOrderDeepLink({ exchange, scripCode, side, price, quantity }) {
  const sideNorm = String(side || "").trim().toUpperCase();
  const exchangeCode = exchangeCodeForDeepLink(exchange);
  const sideCode = sideNorm === "SELL" ? "2" : "1";
  const qtyNum = Number(quantity);
  const qtyCode = Number.isFinite(qtyNum) && qtyNum > 0 ? String(Math.trunc(qtyNum)) : "1";
  const numericPrice = Number(price);
  const priceCode = Number.isFinite(numericPrice) && numericPrice > 0 ? String(numericPrice) : "";
  return ["131", exchangeCode, String(scripCode).trim(), qtyCode, priceCode, sideCode].join("$");
}

// Multi-leg one-tap (verified from Sharekhan gi9 / onetap deepLinking):
// 181$NF-<scrip>-BUY-<price>-<qty>_NF-<scrip>-SELL-<price>-<qty>$<optionalId>
function exchangePrefixForMultiLeg(exchange) {
  const exchangeNorm = String(exchange || "").trim().toUpperCase();
  if (exchangeNorm === "BFO" || exchangeNorm === "BSE") return "BF";
  if (exchangeNorm === "MCX") return "MX";
  if (exchangeNorm === "CDS") return "CD";
  return "NF"; // NFO / NSE F&O
}

function buildMultiLegToken({ exchange, scripCode, side, price, quantity }) {
  const prefix = exchangePrefixForMultiLeg(exchange);
  const sideNorm = String(side || "").trim().toUpperCase() === "SELL" ? "SELL" : "BUY";
  const qtyNum = Number(quantity);
  const qtyCode = Number.isFinite(qtyNum) && qtyNum > 0 ? String(Math.trunc(qtyNum)) : "1";
  const numericPrice = Number(price);
  const priceCode = Number.isFinite(numericPrice) && numericPrice > 0 ? String(numericPrice) : "0";
  return `${prefix}-${String(scripCode).trim()}-${sideNorm}-${priceCode}-${qtyCode}`;
}

function buildMultiLegDeepLink(legs, trailingId = "") {
  const tokens = (Array.isArray(legs) ? legs : [])
    .map((leg) => buildMultiLegToken(leg))
    .filter(Boolean);
  if (tokens.length < 2) throw createHttpError(400, "A 2-leg order needs at least two legs");
  const body = tokens.join("_");
  const trail = String(trailingId || "").trim();
  return trail ? `181$${body}$${trail}` : `181$${body}`;
}

function intentPayload(record) {
  const details = record?.details || {};
  if (record?.kind !== "order-intent") return record?.payload || "";
  if (Array.isArray(details.legs) && details.legs.length >= 2) {
    try {
      return buildMultiLegDeepLink(details.legs, details.multiLegId || "");
    } catch {
      return record?.payload || "";
    }
  }
  if (!/^[1-9]\d{0,12}$/.test(String(details.scripCode || ""))) {
    return record?.payload || "";
  }
  const exchange = String(details.exchange || "").trim().toUpperCase();
  if (!["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange)) {
    return record?.payload || "";
  }
  return buildOrderDeepLink({
    exchange,
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
  const preserved = Boolean(record.preserved);
  if (record.kind === "order-intent") {
    return {
      code: record.code,
      shortUrl: `https://www.emotionlesstraders.com/order/${record.code}`,
      destination: apps.android || apps.ios || "",
      androidAppUrl: apps.android,
      iosAppUrl: apps.ios,
      payload,
      details: record.details,
      kind: record.kind,
      active: record.active,
      preserved,
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
    payload,
    details: record.details,
    kind: record.kind || "sharekhan-deeplink",
    active: record.active,
    preserved,
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
  let orderType = String(source.orderType || "NORMAL").trim().toUpperCase();
  let productType = String(source.productType || "INVESTMENT").trim().toUpperCase();
  const validity = String(source.validity || "GFD").trim().toUpperCase();
  const triggerPrice = Number(source.triggerPrice || 0);
  const quantity = Number(source.quantity);
  const price = Number(source.price);
  const rawBracket = source.bracket && typeof source.bracket === "object" ? source.bracket : {};
  // Bracket / BigTrade+ one-tap + web brackettsl path removed — not reliable in Sharekhan.
  if (
    orderType === "BRACKET" ||
    productType === "BIGTRADEPLUS" ||
    Boolean(rawBracket.enabled) ||
    String(source.openMode || "").toLowerCase() === "brackettsl"
  ) {
    throw createHttpError(
      400,
      "Bracket / BigTrade+ order links are removed. Use Market/Limit with Delivery or Intraday (BigTrade)."
    );
  }
  if (!tradingSymbol || !/^[A-Z0-9._-]+$/.test(tradingSymbol)) throw createHttpError(400, "Valid trading symbol is required");
  if (!["BUY", "SELL"].includes(side)) throw createHttpError(400, "Choose Buy or Sell");
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw createHttpError(400, "Quantity must be a positive whole number");
  if (!Number.isFinite(price) || price < 0) throw createHttpError(400, "Price must be zero or greater");
  if (!["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange)) throw createHttpError(400, "Choose a supported exchange");
  if (!["EQ", "FUT", "OPT"].includes(segment)) throw createHttpError(400, "Choose Equity, Futures, or Options");
  if (segment !== "EQ" && !["NFO", "BFO", "MCX", "CDS"].includes(exchange)) throw createHttpError(400, "Choose a derivatives exchange for Futures or Options");
  if (!["NORMAL", "LIMIT", "STOPLOSS", "STOPLOSS_MARKET"].includes(orderType)) throw createHttpError(400, "Choose a supported Sharekhan order type");
  if (!["INVESTMENT", "BIGTRADE"].includes(productType)) throw createHttpError(400, "Choose Delivery (Investment) or Intraday (BigTrade)");
  if (!["GFD", "IOC"].includes(validity)) throw createHttpError(400, "Choose Day or IOC validity");
  if (orderType !== "NORMAL" && (!Number.isFinite(price) || price <= 0)) throw createHttpError(400, "A positive limit price is required for this order type");
  if (orderType.startsWith("STOPLOSS") && (!Number.isFinite(triggerPrice) || triggerPrice <= 0)) throw createHttpError(400, "A positive trigger price is required for stop-loss orders");
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

  async function normalizeLeg(raw, label) {
    const legSymbol = String(raw.tradingSymbol || "").trim().toUpperCase().slice(0, 60);
    const legSide = String(raw.side || "").trim().toUpperCase();
    const legExchange = String(raw.exchange || exchange).trim().toUpperCase();
    const legSegment = String(raw.segment || segment).trim().toUpperCase();
    const legQty = Number(raw.quantity);
    const legPrice = Number(raw.price);
    if (!legSymbol || !/^[A-Z0-9._-]+$/.test(legSymbol)) throw createHttpError(400, `${label}: valid trading symbol required`);
    if (!["BUY", "SELL"].includes(legSide)) throw createHttpError(400, `${label}: choose Buy or Sell`);
    if (!Number.isSafeInteger(legQty) || legQty < 1) throw createHttpError(400, `${label}: quantity must be a positive whole number`);
    if (!Number.isFinite(legPrice) || legPrice < 0) throw createHttpError(400, `${label}: price must be zero or greater`);
    if (!["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(legExchange)) throw createHttpError(400, `${label}: unsupported exchange`);
    let legScrip = String(raw.scripCode || "").trim();
    if (!/^[1-9]\d{0,12}$/.test(legScrip)) {
      const instrument = await resolveInstrumentForOrder({
        symbol: legSymbol,
        exchange: legExchange,
        segment: legSegment,
        symbolToken: raw.scripCode,
      });
      legScrip = String(instrument?.token || "");
    }
    if (!/^[1-9]\d{0,12}$/.test(legScrip)) {
      throw createHttpError(400, `${label}: Sharekhan scrip code not found for ${legSymbol}`);
    }
    return {
      stock: String(raw.stock || stock || "").trim().slice(0, 120),
      tradingSymbol: legSymbol,
      side: legSide,
      quantity: legQty,
      price: legPrice,
      exchange: legExchange,
      segment: legSegment,
      scripCode: legScrip,
      expiry: String(raw.expiry || "").trim().slice(0, 40),
      strike: String(raw.strike || "").trim().slice(0, 40),
      optionType: String(raw.optionType || "").trim().toUpperCase().slice(0, 10),
      buyRange: String(raw.buyRange || (legPrice > 0 ? legPrice : "")).trim().slice(0, 40),
    };
  }

  let multiLegs = null;
  const rawLegs = Array.isArray(source.legs) ? source.legs.filter(Boolean) : [];
  const leg2 = source.leg2 && typeof source.leg2 === "object" ? source.leg2 : null;
  if (rawLegs.length >= 2 || leg2) {
    const sources = rawLegs.length >= 2
      ? rawLegs.slice(0, 4)
      : [
          { tradingSymbol, exchange, segment, scripCode, side, price, quantity, stock, expiry: source.expiry, strike: source.strike, optionType: source.optionType, buyRange: source.buyRange || source.card?.buyRange },
          leg2,
        ];
    multiLegs = [];
    for (let index = 0; index < sources.length; index += 1) {
      multiLegs.push(await normalizeLeg(sources[index], `Leg ${index + 1}`));
    }
  }

  // Single-leg: 131$…  |  2+ legs: 181$NF-scrip-SIDE-price-qty_…
  const payload = multiLegs
    ? buildMultiLegDeepLink(multiLegs, source.multiLegId || "")
    : (["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange)
      ? buildOrderDeepLink({ exchange, scripCode, side, price, quantity })
      : "");
  const target1 = String(
    source.card?.target1 || source.target1 || source.card?.target || source.target || ""
  ).trim().slice(0, 40);
  const target2 = String(source.card?.target2 || source.target2 || "").trim().slice(0, 40);
  const target3 = String(source.card?.target3 || source.target3 || "").trim().slice(0, 40);
  const card = {
    buyRange: String(source.card?.buyRange || source.buyRange || price || "").trim().slice(0, 40),
    target1,
    target2,
    target3,
    target: [target1, target2, target3].filter(Boolean).join(" / ").slice(0, 80),
    stopLoss: String(source.card?.stopLoss || source.stopLoss || "").trim().slice(0, 40),
    timeFrame: String(source.card?.timeFrame || source.timeFrame || (productType === "BIGTRADE" ? "INTRADAY" : "")).trim().slice(0, 40),
    headline: String(source.card?.headline || source.headline || "").trim().slice(0, 60),
  };
  const details = {
    stock,
    tradingSymbol,
    side,
    quantity,
    price,
    exchange,
    segment,
    scripCode,
    orderType,
    productType,
    validity,
    triggerPrice,
    openMode: "normal",
    bracketWebUrl: webTradeUrl({ exchange, tradingSymbol, scripCode, bracket: { enabled: false }, orderType }),
    card,
    notes: String(source.notes || "").trim().slice(0, 500),
    strategyName: String(source.strategyName || "").trim().slice(0, 80),
    approxMargin: String(source.approxMargin || "").trim().slice(0, 40),
    multiLegId: String(source.multiLegId || "").trim().slice(0, 40),
  };
  if (multiLegs) details.legs = multiLegs;
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
    details: record.details || {},
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
  const records = await collection()
    .find({}, { projection: { createdBy: 0 } })
    .sort({ preserved: -1, createdAt: -1 })
    .limit(120)
    .toArray();
  sendJson(res, 200, { ok: true, links: records.map((record) => publicRecord(record, req)) });
}

async function deactivate(req, res) {
  const existing = await collection().findOne({ code: req.params.code }, { projection: { preserved: 1 } });
  if (!existing) throw createHttpError(404, "Link not found");
  if (existing.preserved) throw createHttpError(403, "Preserved demo links cannot be deactivated");
  const result = await collection().updateOne({ code: req.params.code }, { $set: { active: false } });
  if (!result.matchedCount) throw createHttpError(404, "Link not found");
  sendJson(res, 200, { ok: true });
}

async function remove(req, res) {
  const code = String(req.params.code || "").trim();
  if (!code) throw createHttpError(400, "Link code is required");
  const existing = await collection().findOne({ code }, { projection: { preserved: 1 } });
  if (!existing) throw createHttpError(404, "Link not found");
  if (existing.preserved) throw createHttpError(403, "Preserved demo links cannot be deleted");
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
  buildMultiLegDeepLink,
  webTradeUrl,
  mobileAppUrls,
  pickMobileAppUrl,
  ourOnetapUrl,
  isValidDeepLinkPayload,
};
