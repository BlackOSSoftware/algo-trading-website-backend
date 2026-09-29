const WebSocket = require("ws");

const STREAM_URL = "wss://stream.sharekhan.com/skstream/api/stream";

function setting(name, fallback, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

// Sharekhan quote dates are MM/dd/yyyy in exchange time (India).
function feedTime(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (match) {
    const [, month, day, year, hour, minute, second] = match;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return NaN;
    return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+05:30`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(String(value || ""))) return NaN;
  return Date.parse(value);
}

class SharekhanStream {
  constructor({ apiKey, accessToken, socketFactory = (url) => new WebSocket(url, { handshakeTimeout: 10000 }), onDispose = () => {} }) {
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.socketFactory = socketFactory;
    this.onDispose = onDispose;
    this.pending = new Map();
    this.quotes = new Map();
    this.subscriptions = new Set();
    this.ready = false;
    this.closed = false;
    this.attempt = 0;
  }

  send(action, key, value) {
    this.socket.send(JSON.stringify({ action, key: [key], value: [value] }));
  }

  connect() {
    if (this.closed || this.socket || this.reconnectTimer) return;
    const url = new URL(STREAM_URL);
    url.searchParams.set("ACCESS_TOKEN", this.accessToken);
    url.searchParams.set("API_KEY", this.apiKey);
    try {
      const socket = this.socketFactory(url.toString());
      this.socket = socket;
      this.connectTimer = setTimeout(() => socket.terminate(), 10000);
      socket.on("message", (raw) => {
        if (socket !== this.socket || this.closed) return;
        try { this.receive(JSON.parse(String(raw))); } catch { /* Ignore malformed frames. */ }
      });
      socket.on("error", () => socket.terminate());
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode;
        response.resume();
        if (status === 401 || status === 403) {
          this.dispose({ status, expired: true, error: "Admin Sharekhan session expired. Login again in Admin > Sharekhan Prices." });
        } else {
          socket.terminate();
        }
      });
      socket.on("close", () => {
        if (socket !== this.socket) return;
        clearTimeout(this.connectTimer);
        clearInterval(this.heartbeat);
        this.socket = null;
        this.ready = false;
        this.quotes.clear();
        if (!this.closed) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, Math.min(1000 * 2 ** this.attempt++, 15000));
          this.reconnectTimer.unref?.();
        }
      });
      socket.on("pong", () => { this.alive = true; });
    } catch {
      this.dispose({ error: "Unable to connect to Sharekhan live feed" });
    }
  }

  receive(message) {
    if (Number(message.status) !== 100) {
      if (message.status != null) {
        const status = Number(message.status);
        this.dispose({ status, expired: status === 401 || status === 403,
          error: "Sharekhan live feed rejected the request. Check session and instrument subscription." });
      }
      return;
    }
    if (message.message === "connect") {
      this.send("subscribe", "feed", "");
      return;
    }
    if (message.message === "subscribe" && /^success\s*feed$/i.test(String(message.data).trim())) {
      clearTimeout(this.connectTimer);
      this.ready = true;
      this.attempt = 0;
      this.alive = true;
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (!this.alive) return this.socket?.terminate();
        this.alive = false;
        this.socket?.ping();
      }, 30000);
      this.heartbeat.unref?.();
      if (this.subscriptions.size) this.send("feed", "ltp", [...this.subscriptions].join(","));
      return;
    }
    if (message.message !== "feed") return;
    for (const tick of Array.isArray(message.data) ? message.data : [message.data]) {
      if (!tick || typeof tick !== "object") continue;
      const key = `${tick.exchangeCode}${tick.scripCode}`;
      const waiters = this.pending.get(key);
      const price = Number(tick.ltp);
      if (!this.subscriptions.has(key) || !Number.isFinite(price) || price <= 0) continue;
      const timestamp = feedTime(tick.lastUpdatedTime || message.timestamp);
      const age = Date.now() - timestamp;
      const maxAge = setting("SHAREKHAN_WS_MAX_TICK_AGE_MS", 5000, 60000);
      if (!Number.isFinite(timestamp) || age > maxAge || age < -5000) continue;
      const quote = { ok: true, price: String(price),
        result: { exchange: tick.exchangeCode, scripCode: tick.scripCode, ltp: price,
          timestamp: new Date(timestamp).toISOString(), receivedAt: new Date().toISOString() } };
      this.quotes.set(key, quote);
      this.lastTickAt = quote.result.receivedAt;
      for (const waiter of [...(waiters || [])]) waiter.finish(quote);
    }
  }

  getPrice(exchange, scripCode) {
    if (this.closed) return Promise.resolve(this.failure || { ok: false, error: "Sharekhan live feed closed" });
    const key = `${exchange}${scripCode}`;
    if (!this.subscriptions.has(key) && this.subscriptions.size >= 1000) {
      return Promise.resolve({ ok: false, error: "Sharekhan live feed subscription limit reached" });
    }
    const cached = this.quotes.get(key);
    if (this.ready && cached && Date.now() - Date.parse(cached.result.timestamp) <=
        setting("SHAREKHAN_WS_MAX_TICK_AGE_MS", 5000, 60000)) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const waiters = this.pending.get(key) || new Set();
      this.pending.set(key, waiters);
      const waiter = { finish: (result) => {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        if (!waiters.size) this.pending.delete(key);
        resolve(result);
      } };
      waiter.timer = setTimeout(() => waiter.finish({ ok: false,
        error: `No fresh Sharekhan WebSocket price for ${key}. Order was not sent.` }),
      setting("SHAREKHAN_WS_PRICE_TIMEOUT_MS", 10000, 60000));
      waiters.add(waiter);
      const isNew = !this.subscriptions.has(key);
      this.subscriptions.add(key);
      if (this.ready && isNew) {
        try { this.send("feed", "ltp", key); } catch { this.socket?.terminate(); }
      }
      // New or stale instruments wait for a fresh tick on the shared feed.
      this.connect();
    });
  }

  dispose(detail = {}) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.failure = { ok: false, error: "Sharekhan live feed closed", ...detail };
    clearTimeout(this.idleTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    for (const waiters of [...this.pending.values()]) {
      for (const waiter of [...waiters]) waiter.finish(this.failure);
    }
    this.socket?.terminate();
    this.subscriptions.clear();
    this.quotes.clear();
    this.onDispose();
  }
}

// Only the admin market-data service can construct the production connection.
module.exports = { SharekhanStream };
