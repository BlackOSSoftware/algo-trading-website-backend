const {
  mstockInstrumentsCollection,
  replaceAllInstruments,
  countInstruments,
} = require("../models/mstockInstrument.model");

const SCRIP_URLS = [
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
];

const SUPPORTED_EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"]);
const MONTHS = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

const FRESH_MS = 12 * 60 * 60 * 1000;
const MIN_USEFUL_COUNT = 5000;

let syncPromise = null;
let freshUntil = 0;

function normalizeString(value) {
  return String(value || "").trim();
}

function parseAngelExpiry(value) {
  const match = /^(\d{1,2})([A-Z]{3})(\d{4})$/i.exec(normalizeString(value).toUpperCase());
  if (!match || MONTHS[match[2]] === undefined) return null;
  return new Date(Date.UTC(Number(match[3]), MONTHS[match[2]], Number(match[1])));
}

function isExpiredContract(expiry) {
  const parsed = parseAngelExpiry(expiry);
  if (!parsed) return false;
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  return parsed < cutoff;
}

function normalizeStrike(value, instrumentType) {
  if (!/OPT/i.test(instrumentType)) return "";
  const strike = Number(normalizeString(value).replace(/,/g, ""));
  if (!Number.isFinite(strike) || strike <= 0) return "";
  // Angel's public master stores option strikes in paise (price × 100).
  const price = Math.round((strike / 100) * 100) / 100;
  return String(price);
}

function mapAngelRow(row) {
  const exchange = normalizeString(row?.exch_seg || row?.exchange).toUpperCase();
  const token = normalizeString(row?.token);
  const symbol = normalizeString(row?.symbol).toUpperCase();
  if (!token || !symbol || !SUPPORTED_EXCHANGES.has(exchange)) return null;
  if (!/^[1-9]\d{0,12}$/.test(token)) return null;

  let instrumenttype = normalizeString(row?.instrumenttype).toUpperCase();
  if (instrumenttype === "AMXIDX") return null;
  const expiry = normalizeString(row?.expiry).toUpperCase();
  if (isExpiredContract(expiry)) return null;

  if ((exchange === "NSE" || exchange === "BSE") && !instrumenttype) {
    instrumenttype = "EQ";
  }

  return {
    token,
    symbol,
    name: normalizeString(row?.name) || symbol,
    exch_seg: exchange,
    instrumenttype,
    expiry,
    strike: normalizeStrike(row?.strike, instrumenttype),
    lotsize: normalizeString(row?.lotsize).replace(/\.0+$/, ""),
    tick_size: normalizeString(row?.tick_size),
  };
}

async function downloadScripMaster() {
  let lastError = "Angel One scrip master download failed";
  for (const url of SCRIP_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `Angel One scrip master returned HTTP ${response.status}`;
        continue;
      }
      const payload = await response.json();
      const entries = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
      if (!entries.length) {
        lastError = "Angel One scrip master was empty";
        continue;
      }
      return { url, entries };
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError);
}

async function latestSyncAt() {
  const doc = await mstockInstrumentsCollection().findOne(
    {},
    { projection: { syncedAt: 1 }, sort: { syncedAt: -1 } }
  );
  return normalizeString(doc?.syncedAt);
}

async function syncAngelInstruments() {
  const downloaded = await downloadScripMaster();
  const mapped = [];
  const byExchange = {};

  for (const row of downloaded.entries) {
    const doc = mapAngelRow(row);
    if (!doc) continue;
    mapped.push(doc);
    byExchange[doc.exch_seg] = (byExchange[doc.exch_seg] || 0) + 1;
  }

  if (!mapped.length) {
    return { ok: false, error: "Angel One scrip master had no tradable instruments" };
  }

  const stored = await replaceAllInstruments(mapped);
  freshUntil = Date.now() + 10 * 60 * 1000;
  return {
    ok: stored.totalStored > 0,
    skipped: false,
    source: downloaded.url,
    fetched: downloaded.entries.length,
    mapped: mapped.length,
    byExchange,
    totalStored: stored.totalStored,
    syncedAt: stored.syncedAt,
  };
}

async function ensureAngelInstruments() {
  if (Date.now() < freshUntil) return { ok: true, skipped: true };
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    const count = await countInstruments();
    const syncedAt = await latestSyncAt();
    const syncedMs = Date.parse(syncedAt);
    const fresh =
      count >= MIN_USEFUL_COUNT &&
      Number.isFinite(syncedMs) &&
      Date.now() - syncedMs < FRESH_MS;
    if (fresh) {
      freshUntil = Date.now() + 10 * 60 * 1000;
      return { ok: true, skipped: true, count, syncedAt };
    }
    return syncAngelInstruments();
  })().finally(() => {
    syncPromise = null;
  });

  return syncPromise;
}

module.exports = {
  syncAngelInstruments,
  ensureAngelInstruments,
};
