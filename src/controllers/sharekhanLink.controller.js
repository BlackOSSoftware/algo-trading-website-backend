const crypto = require("crypto");
const { getDb } = require("../config/db");
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

function publicRecord(record, req) {
  const base = (process.env.PUBLIC_API_URL || "https://api.emotionlesstraders.com").replace(/\/$/, "");
  return { code: record.code, shortUrl: `${base}/l/${record.code}`, destination: `${BASE}?deepLinking=${encodeURIComponent(record.payload)}`,
    details: record.details, active: record.active, createdAt: record.createdAt, clicks: record.clicks || 0 };
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
  if (!record) throw createHttpError(404, "Link not found or inactive");
  await collection().updateOne({ _id: record._id }, { $inc: { clicks: 1 } });
  res.writeHead(302, { Location: `${BASE}?deepLinking=${encodeURIComponent(record.payload)}`,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

module.exports = { create, list, deactivate, redirect, parsePayload };
