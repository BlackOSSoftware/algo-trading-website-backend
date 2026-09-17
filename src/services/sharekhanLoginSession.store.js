const fs = require("fs");
const path = require("path");

const TTL_MS = 30 * 60 * 1000;
const STORE_PATH = path.join(require("os").tmpdir(), "wt-sharekhan-login-sessions.json");

/** @type {Map<string, any>} */
const sessions = new Map();
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [userId, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === "object") {
        sessions.set(String(userId), entry);
      }
    }
  } catch {
    // ignore corrupt store
  }
}

function persist() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {};
    for (const [userId, entry] of sessions.entries()) {
      payload[userId] = entry;
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(payload), "utf8");
  } catch {
    // ignore disk failures — memory still works
  }
}

function pruneExpired() {
  ensureLoaded();
  const now = Date.now();
  let changed = false;
  for (const [userId, entry] of sessions.entries()) {
    if (!entry || now - Number(entry.updatedAt || 0) > TTL_MS) {
      sessions.delete(userId);
      changed = true;
    }
  }
  if (changed) persist();
}

function getSession(userId) {
  pruneExpired();
  const key = String(userId || "").trim();
  if (!key) return null;
  return sessions.get(key) || null;
}

function touchSession(userId, patch) {
  ensureLoaded();
  const key = String(userId || "").trim();
  if (!key) return null;
  const current = getSession(key) || {};
  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  sessions.set(key, next);
  persist();
  return next;
}

function saveSharekhanLoginPrep(userId, prep) {
  return touchSession(userId, {
    prep: prep && typeof prep === "object" ? prep : null,
    result: null,
  });
}

function getSharekhanLoginPrep(userId) {
  return getSession(userId)?.prep || null;
}

function saveSharekhanLoginResult(userId, result) {
  return touchSession(userId, {
    result: result && typeof result === "object" ? result : null,
  });
}

function takeSharekhanLoginResult(userId) {
  const session = getSession(userId);
  if (!session?.result) return null;
  const result = session.result;
  // Keep prep after success too so a refresh/retry does not force retyping keys.
  touchSession(userId, { result: null });
  return result;
}

module.exports = {
  saveSharekhanLoginPrep,
  getSharekhanLoginPrep,
  saveSharekhanLoginResult,
  takeSharekhanLoginResult,
};
