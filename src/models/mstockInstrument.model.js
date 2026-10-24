const { getDb } = require("../config/db");

function mstockInstrumentsCollection() {
  return getDb().collection("mstock_instruments");
}

function normalizeString(value) {
  return String(value || "").trim();
}

function buildInstrumentDoc(entry, syncedAt) {
  const token = normalizeString(entry?.token);
  const symbol = normalizeString(entry?.symbol).toUpperCase();
  const name = normalizeString(entry?.name);
  const exchange = normalizeString(entry?.exch_seg || entry?.exchange).toUpperCase();
  const instrumentType = normalizeString(
    entry?.instrumenttype || entry?.instrument_type
  ).toUpperCase();
  const expiry = normalizeString(entry?.expiry);
  const strike = normalizeString(entry?.strike);
  const lotSize = normalizeString(entry?.lotsize || entry?.lot_size);
  const tickSize = normalizeString(entry?.tick_size || entry?.tickSize);

  if (!token || !symbol || !exchange) return null;

  const searchText = [symbol, name, exchange, instrumentType, token]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  return {
    _id: `${exchange}:${token}`,
    token,
    symbol,
    name,
    exchange,
    instrumentType,
    expiry,
    strike,
    lotSize,
    tickSize,
    searchText,
    syncedAt,
    updatedAt: syncedAt,
  };
}

async function replaceAllInstruments(entries) {
  const syncedAt = new Date().toISOString();
  const docs = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const doc = buildInstrumentDoc(entry, syncedAt);
    if (!doc || seen.has(doc._id)) continue;
    seen.add(doc._id);
    docs.push(doc);
  }

  const collection = mstockInstrumentsCollection();
  await collection.deleteMany({});

  const chunkSize = 2500;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const result = await collection.insertMany(chunk, { ordered: false });
    inserted += result.insertedCount || chunk.length;
  }

  return {
    totalFetched: Array.isArray(entries) ? entries.length : 0,
    totalStored: inserted,
    syncedAt,
  };
}

async function replaceExchangeInstruments(exchange, entries) {
  const exchangeNorm = normalizeString(exchange).toUpperCase();
  if (!exchangeNorm) {
    return { totalFetched: 0, totalStored: 0, syncedAt: "" };
  }

  const syncedAt = new Date().toISOString();
  const docs = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const doc = buildInstrumentDoc({ ...entry, exchange: exchangeNorm }, syncedAt);
    if (!doc || seen.has(doc._id)) continue;
    seen.add(doc._id);
    docs.push(doc);
  }

  if (!docs.length) {
    return { totalFetched: Array.isArray(entries) ? entries.length : 0, totalStored: 0, syncedAt };
  }

  const collection = mstockInstrumentsCollection();
  await collection.deleteMany({ exchange: exchangeNorm });

  const chunkSize = 2500;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const result = await collection.insertMany(chunk, { ordered: false });
    inserted += result.insertedCount || chunk.length;
  }

  return {
    totalFetched: Array.isArray(entries) ? entries.length : 0,
    totalStored: inserted,
    syncedAt,
  };
}

async function countInstruments() {
  return mstockInstrumentsCollection().countDocuments();
}

function expirySortValue(value) {
  const raw = normalizeString(value);
  const slash = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (slash) return Number(`${slash[3]}${slash[2]}${slash[1]}`);
  const dashed = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (dashed) return Number(`${dashed[3]}${dashed[2]}${dashed[1]}`);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`);
  return Number.MAX_SAFE_INTEGER;
}

async function countInstrumentsByExchange(exchange) {
  const exchangeNorm = normalizeString(exchange).toUpperCase();
  if (!exchangeNorm) return 0;
  return mstockInstrumentsCollection().countDocuments({ exchange: exchangeNorm });
}

async function latestInstrumentSync(exchange) {
  const exchangeNorm = normalizeString(exchange).toUpperCase();
  if (!exchangeNorm) return "";
  const doc = await mstockInstrumentsCollection().findOne(
    { exchange: exchangeNorm },
    { projection: { syncedAt: 1 } }
  );
  return normalizeString(doc?.syncedAt);
}

async function searchInstruments(query, { limit = 20, exchange = "", instrumentType = "", segment = "", expiry = "" } = {}) {
  const q = normalizeString(query).toUpperCase();
  const expiryNorm = normalizeString(expiry);
  if (!q && !expiryNorm) return [];

  const filter = { $and: [] };
  if (q) filter.$and.push(
      {
        $or: [
          { symbol: { $regex: `^${escapeRegex(q)}` } },
          { name: { $regex: `^${escapeRegex(q)}` } },
          { searchText: { $regex: escapeRegex(q) } },
        ],
      }
  );

  const exchangeNorm = normalizeString(exchange).toUpperCase();
  if (exchangeNorm) filter.$and.push({ exchange: exchangeNorm });
  if (expiryNorm) filter.$and.push({ expiry: expiryNorm });

  const segmentNorm = normalizeString(segment).toUpperCase();
  const typeNorm = normalizeString(instrumentType).toUpperCase();
  if (segmentNorm === "OPT" || typeNorm === "OPT") {
    filter.$and.push({ instrumentType: { $regex: "OPT", $options: "i" } });
  } else if (segmentNorm === "FUT" || (exchangeNorm === "MCX" && !typeNorm)) {
    filter.$and.push({ instrumentType: { $not: /OPT/i } });
  } else if (typeNorm === "EQ") {
    filter.$and.push({ instrumentType: { $in: ["EQ", "EQUITY"] } });
  } else if (typeNorm) {
    filter.$and.push({ instrumentType: typeNorm });
  }

  const max = Math.max(1, Math.min(Number(limit) || 20, 50));
  const rows = await mstockInstrumentsCollection()
    .find(filter)
    .project({
      token: 1,
      symbol: 1,
      name: 1,
      exchange: 1,
      instrumentType: 1,
      expiry: 1,
      strike: 1,
      lotSize: 1,
    })
    .limit(Math.min(max * 8, 120))
    .toArray();

  const score = (doc) => {
    const symbol = String(doc.symbol || "").toUpperCase();
    const name = String(doc.name || "").toUpperCase();
    const searchText = String(doc.searchText || "").toUpperCase();
    if (q && symbol === q) return 0;
    if (q && symbol.startsWith(q)) return 1;
    if (q && (name.startsWith(q) || name.startsWith(`${q}-`))) return 2;
    if (q && searchText.includes(` ${q}`)) return 3;
    return 3;
  };

  rows.sort((a, b) => {
    const scoreDiff = score(a) - score(b);
    if (scoreDiff !== 0) return scoreDiff;
    const expiryDiff = expirySortValue(a.expiry) - expirySortValue(b.expiry);
    if (expiryDiff !== 0) return expiryDiff;
    return String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });

  return rows.slice(0, max);
}

async function listInstrumentExpiries({ query = "", exchange = "", segment = "" } = {}) {
  const collection = mstockInstrumentsCollection();
  const q = normalizeString(query).toUpperCase();
  const filter = { $and: [] };
  if (q) filter.$and.push({ $or: [
    { symbol: { $regex: `^${escapeRegex(q)}` } },
    { name: { $regex: `^${escapeRegex(q)}` } },
    { searchText: { $regex: escapeRegex(q) } },
  ] });
  const exchangeNorm = normalizeString(exchange).toUpperCase();
  if (exchangeNorm) filter.$and.push({ exchange: exchangeNorm });
  const type = normalizeString(segment).toUpperCase();
  if (type === "OPT") filter.$and.push({ instrumentType: { $regex: "OPT", $options: "i" } });
  else if (type === "FUT") filter.$and.push({ instrumentType: { $regex: "FUT|FS|FI", $options: "i" } });
  else return [];
  const rows = await collection.aggregate([
    { $match: filter },
    { $group: { _id: "$expiry", count: { $sum: 1 } } },
    { $limit: 100 },
  ]).toArray();
  const monthMap = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const expiryTime = (value) => {
    const raw = normalizeString(value);
    const compact = /^(\d{1,2})([A-Z]{3})(\d{4})$/i.exec(raw);
    if (compact && monthMap[compact[2].toUpperCase()] !== undefined) return Date.UTC(Number(compact[3]), monthMap[compact[2].toUpperCase()], Number(compact[1]));
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  return rows.filter((row) => row._id).map((row) => ({ expiry: row._id, contracts: row.count }))
    .sort((a, b) => expiryTime(a.expiry) - expiryTime(b.expiry));
}

async function resolveInstrumentForOrder({
  symbol = "",
  exchange = "",
  segment = "",
  symbolToken = "",
} = {}) {
  const collection = mstockInstrumentsCollection();
  const token = normalizeString(symbolToken);
  if (token) {
    const byToken = await collection.findOne(
      exchange
        ? { token, exchange: normalizeString(exchange).toUpperCase() }
        : { token }
    );
    if (byToken) return byToken;
  }

  const sym = normalizeString(symbol).toUpperCase().replace(/-(EQ|FUT|OPT)$/i, "");
  if (!sym) return null;

  const exchangeNorm = normalizeString(exchange).toUpperCase();
  const segmentNorm = normalizeString(segment).toUpperCase();
  const filter = {
    $and: [
      {
        $or: [
          { symbol: sym },
          { symbol: { $regex: `^${escapeRegex(sym)}` } },
          { name: { $regex: `^${escapeRegex(sym)}` } },
          { searchText: { $regex: escapeRegex(sym) } },
        ],
      },
    ],
  };
  if (exchangeNorm) filter.$and.push({ exchange: exchangeNorm });

  if (segmentNorm === "EQ") {
    filter.$and.push({ instrumentType: { $in: ["EQ", "EQUITY"] } });
  } else if (segmentNorm === "FUT") {
    filter.$and.push({
      instrumentType: { $regex: /FUT|FUTSTK|FUTIDX|FUTCOM|FUTCUR|FS|FI/i },
    });
  } else if (segmentNorm === "OPT") {
    filter.$and.push({
      instrumentType: { $regex: /OPT|OPTSTK|OPTIDX|OPTCUR|OI|OS/i },
    });
  }

  const rows = await collection.find(filter).limit(80).toArray();
  if (!rows.length) return null;

  const score = (doc) => {
    const dSym = String(doc.symbol || "").toUpperCase();
    const dName = String(doc.name || "").toUpperCase();
    const type = String(doc.instrumentType || "").toUpperCase();
    let value = 50;
    if (dSym === sym) value = 0;
    else if (dSym === `${sym}-EQ` || dName === `${sym}-EQ`) value = 1;
    else if (dSym.startsWith(sym)) value = 2;
    else if (dName.startsWith(sym)) value = 3;
    if (segmentNorm === "EQ" && (type === "EQ" || type === "EQUITY")) value -= 5;
    if (segmentNorm === "FUT" && /FUT|FS|FI/.test(type)) value -= 5;
    if (segmentNorm === "OPT" && /OPT|OI|OS|CE|PE/.test(type)) value -= 5;
    if (doc.expiry) value += 1;
    return value;
  };

  rows.sort((a, b) => {
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    return String(a.expiry || "").localeCompare(String(b.expiry || ""));
  });

  return rows[0];
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  mstockInstrumentsCollection,
  replaceAllInstruments,
  replaceExchangeInstruments,
  countInstruments,
  countInstrumentsByExchange,
  latestInstrumentSync,
  searchInstruments,
  listInstrumentExpiries,
  resolveInstrumentForOrder,
};
