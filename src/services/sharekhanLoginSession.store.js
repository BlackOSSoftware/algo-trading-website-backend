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

function sessionKey(userId, scope) {
  const key = String(userId || "").trim();
  if (!key) return "";
  return scope === "manual" ? `${key}:manual` : key;
}

function getSession(userId, scope) {
  pruneExpired();
  const key = sessionKey(userId, scope);
  if (!key) return null;
  return sessions.get(key) || null;
}

function touchSession(userId, patch, scope) {
  ensureLoaded();
  const key = sessionKey(userId, scope);
  if (!key) return null;
  const current = sessions.get(key) || {};
  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  sessions.set(key, next);
  persist();
  return next;
}

function saveSharekhanLoginPrep(userId, prep, scope) {
  return touchSession(
    userId,
    {
      prep: prep && typeof prep === "object" ? prep : null,
      result: null,
    },
    scope
  );
}

function getSharekhanLoginPrep(userId, scope) {
  return getSession(userId, scope)?.prep || null;
}

function saveSharekhanLoginResult(userId, result, scope) {
  return touchSession(
    userId,
    {
      result: result && typeof result === "object" ? result : null,
    },
    scope
  );
}

function takeSharekhanLoginResult(userId, scope) {
  const session = getSession(userId, scope);
  if (!session?.result) return null;
  const result = session.result;
  // Keep prep after success too so a refresh/retry does not force retyping keys.
  touchSession(userId, { result: null }, scope);
  return result;
}

module.exports = {
  saveSharekhanLoginPrep,
  getSharekhanLoginPrep,
  saveSharekhanLoginResult,
  takeSharekhanLoginResult,
};
