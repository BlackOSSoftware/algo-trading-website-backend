const crypto = require("crypto");
const { getDb } = require("../config/db");
const { resolveInstrumentForOrder } = require("../models/mstockInstrument.model");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");

const collection = () => getDb().collection("sharekhan_links");
const BASE = "https://downloads.sharekhan.com/download/sharemobile/onetap.html";

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
  if (!/^\d+(?:\$\d+){1,30}$/.test(payload) || payload.length > 300) {
    throw createHttpError(400, "Enter a verified numeric $-separated deepLinking payload");
  }
  return payload;
}

function onetapUrl(payload) {
  return `${BASE}?deepLinking=${payload}`;
}

function buildOrderDeepLink({ exchange, scripCode, side, price, quantity }) {
  const exchangeCode = exchange === "BSE" ? "11" : "12";
  const sideCode = side === "SELL" ? "2" : "1";
  const priceCode = String(Math.round(Number(price) || 0));
  return ["131", exchangeCode, String(scripCode), sideCode, priceCode, String(quantity), "0", "0", "0", "0", "0", "0"].join("$");
}

function publicRecord(record, req) {
  const base = (process.env.PUBLIC_API_URL || "https://api.emotionlesstraders.com").replace(/\/$/, "");
  if (record.kind === "order-intent" && !record.payload) return { code: record.code,
    shortUrl: `https://www.emotionlesstraders.com/order/${record.code}`,
    details: record.details, kind: record.kind, active: record.active,
    createdAt: record.createdAt, clicks: record.clicks || 0 };
  return { code: record.code, shortUrl: `${base}/l/${record.code}`, destination: onetapUrl(record.payload),
    details: record.details, kind: record.kind || "sharekhan-deeplink", active: record.active, createdAt: record.createdAt, clicks: record.clicks || 0 };
}

async function createIntent(req, res) {
  const body = await parseBody(req);
  const source = body.details || {};
  const stock = String(source.stock || "").trim().slice(0, 120);
  const tradingSymbol = String(source.tradingSymbol || "").trim().toUpperCase().slice(0, 60);
  const side = String(source.side || "").trim().toUpperCase();
  const exchange = String(source.exchange || "").trim().toUpperCase();
  const orderType = String(source.orderType || "NORMAL").trim().toUpperCase();
  const productType = String(source.productType || "INVESTMENT").trim().toUpperCase();
  const quantity = Number(source.quantity);
  const price = Number(source.price);
  if (!tradingSymbol || !/^[A-Z0-9._-]+$/.test(tradingSymbol)) throw createHttpError(400, "Valid trading symbol is required");
  if (!["BUY", "SELL"].includes(side)) throw createHttpError(400, "Choose Buy or Sell");
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw createHttpError(400, "Quantity must be a positive whole number");
  if (!Number.isFinite(price) || price < 0) throw createHttpError(400, "Price must be zero or greater");
  if (!["NSE", "BSE"].includes(exchange)) throw createHttpError(400, "Choose NSE or BSE");
  if (!/^[A-Z0-9+_-]{1,30}$/.test(orderType) || !/^[A-Z0-9+_-]{1,30}$/.test(productType)) throw createHttpError(400, "Invalid order or product type");
  let scripCode = String(source.scripCode || "").trim();
  if (!/^[1-9]\d{0,12}$/.test(scripCode)) {
    const instrument = await resolveInstrumentForOrder({ symbol: tradingSymbol, exchange, segment: "EQ" });
    scripCode = String(instrument?.token || "");
  }
  if (!/^[1-9]\d{0,12}$/.test(scripCode)) {
    throw createHttpError(400, "Sharekhan scrip code not found. Enter the scrip code, or sync the script master.");
  }
  const payload = buildOrderDeepLink({ exchange, scripCode, side, price, quantity });
  const details = { stock, tradingSymbol, side, quantity, price, exchange, scripCode,
    orderType, productType, notes: String(source.notes || "").trim().slice(0, 500) };
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
  sendJson(res, 200, { ok: true, details: record.details, appUrl: record.payload ? onetapUrl(record.payload) : "" });
}

async function create(req, res) {
  const body = await parseBody(req);
  const payload = parsePayload(body.payload);
  const allowed = ["stock", "tradingSymbol", "side", "quantity", "price", "exchange", "orderType", "productType", "notes"];
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
  res.writeHead(302, { Location: onetapUrl(record.payload),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

module.exports = { create, createIntent, getIntent, list, deactivate, redirect, parsePayload, buildOrderDeepLink };
