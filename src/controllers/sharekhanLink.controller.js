const crypto = require("crypto");
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

// The old Sharekhan one-tap host has an expired TLS certificate. Keep every app-generated destination on its valid trading host.
function onetapUrl(_payload, details) {
  return webTradeUrl(details);
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
  if (record.kind === "order-intent" && !record.payload) return { code: record.code,
    shortUrl: `https://www.emotionlesstraders.com/order/${record.code}`,
    details: record.details, kind: record.kind, active: record.active,
    createdAt: record.createdAt, clicks: record.clicks || 0 };
  return { code: record.code, shortUrl: `${base}/l/${record.code}`, destination: onetapUrl(intentPayload(record), record.details),
    details: record.details, kind: record.kind || "sharekhan-deeplink", active: record.active, createdAt: record.createdAt, clicks: record.clicks || 0 };
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
  const details = { stock, tradingSymbol, side, quantity, price, exchange, segment, scripCode,
    orderType, productType, validity, triggerPrice,
    bracket,
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
  sendJson(res, 200, { ok: true, details: record.details, appUrl: webTradeUrl(record.details) });
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

async function redirect(req, res) {
  const record = await collection().findOne({ code: req.params.code, active: true });
  if (!record?.payload) throw createHttpError(404, "Link not found or inactive");
  await collection().updateOne({ _id: record._id }, { $inc: { clicks: 1 } });
  res.writeHead(302, { Location: onetapUrl(intentPayload(record), record.details),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

module.exports = { create, createIntent, getIntent, list, deactivate, redirect, parsePayload, buildOrderDeepLink, webTradeUrl };
