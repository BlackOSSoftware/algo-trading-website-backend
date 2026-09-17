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

async function countInstruments() {
  return mstockInstrumentsCollection().countDocuments();
}

async function searchInstruments(query, { limit = 20, exchange = "", instrumentType = "" } = {}) {
  const q = normalizeString(query).toUpperCase();
  if (!q || q.length < 1) return [];

  const filter = {
    $and: [
      {
        $or: [
          { symbol: { $regex: `^${escapeRegex(q)}` } },
          { name: { $regex: `^${escapeRegex(q)}` } },
          { searchText: { $regex: escapeRegex(q) } },
        ],
      },
    ],
  };

  const exchangeNorm = normalizeString(exchange).toUpperCase();
  if (exchangeNorm) filter.$and.push({ exchange: exchangeNorm });

  const typeNorm = normalizeString(instrumentType).toUpperCase();
  if (typeNorm === "EQ") {
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
    if (symbol === q) return 0;
    if (symbol.startsWith(q)) return 1;
    if (name.startsWith(q) || name.startsWith(`${q}-`)) return 2;
    return 3;
  };

  rows.sort((a, b) => {
    const scoreDiff = score(a) - score(b);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });

  return rows.slice(0, max);
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
  countInstruments,
  searchInstruments,
  resolveInstrumentForOrder,
};
