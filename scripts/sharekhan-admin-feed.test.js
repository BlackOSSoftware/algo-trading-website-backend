const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

function mockModule(t, name, exports) {
  const path = require.resolve(name);
  const original = require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
  t.after(() => { if (original) require.cache[path] = original; else delete require.cache[path]; });
}
function freshModule(t, name) {
  const path = require.resolve(name);
  const original = require.cache[path];
  delete require.cache[path];
  t.after(() => { if (original) require.cache[path] = original; else delete require.cache[path]; });
  return require(name);
}

test("one persistent admin stream serves all users; rotation closes old stream; expiry stays separate", async (t) => {
  const created = [];
  class FakeStream {
    constructor(credentials) { this.credentials = credentials; this.subscriptions = new Set(); created.push(this); }
    connect() { this.ready = true; }
    dispose() { this.closed = true; this.ready = false; }
    async getPrice(exchange, scripCode) {
      this.subscriptions.add(`${exchange}${scripCode}`);
      return this.closed ? { ok: false, expired: true } : { ok: true, price: "123.45" };
    }
  }
  const config = { enabled: true, apiKey: "admin-key", accessToken: "admin-token" };
  mockModule(t, "../src/services/sharekhanStream.service", { SharekhanStream: FakeStream });
  mockModule(t, "../src/models/sharekhanMarketData.model", { getMarketDataConfig: async () => config });
  const service = freshModule(t, "../src/services/sharekhanMarketData.service");
  assert.equal((await service.getSharekhanStreamPrice({ exchange: "NC", scripCode: "22" })).ok, false);
  await service.startSharekhanMarketData();
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].credentials, { apiKey: "admin-key", accessToken: "admin-token" });
  const quotes = await Promise.all(["user-a", "user-b"].map((accessToken) => service.getSharekhanStreamPrice({ exchange: "NC", scripCode: "22", accessToken })));
  assert.equal(quotes.every((quote) => quote.price === "123.45"), true);
  assert.equal(created.length, 1);
  service.connectAdminMarketData({ ...config, accessToken: "rotated" });
  assert.equal(created[0].closed, true);
  assert.equal(created[1].subscriptions.has("NC22"), true);
  assert.equal(created[1].credentials.accessToken, "rotated");
  created[1].dispose();
  const expired = await service.getSharekhanStreamPrice({ exchange: "NC", scripCode: "22" });
  assert.equal(expired.expired, false);
  assert.equal(expired.marketDataExpired, true);
  service.closeSharekhanStreams();
  assert.equal(service.marketDataStatus().state, "disconnected");
});

test("admin login state is single use and user bound; responses never expose broker credentials", async (t) => {
  let config = {};
  let connected;
  mockModule(t, "../src/models/sharekhanMarketData.model", {
    getMarketDataConfig: async () => config,
    saveMarketDataConfig: async (patch) => { config = { ...config, ...patch }; },
    takeLoginPrep: async (userId, state) => {
      if (config.login?.userId !== userId || config.login?.state !== state) return null;
      const previous = { ...config };
      delete config.login;
      return previous;
    },
  });
  mockModule(t, "../src/services/sharekhan.service", {
    buildSharekhanLoginUrl: ({ state }) => `https://api.sharekhan.com/login?state=${state}`,
    exchangeSharekhanAccessToken: async ({ apiKey, secureKey }) => {
      assert.equal(apiKey, "admin-key");
      assert.equal(secureKey, "admin-secret");
      return { ok: true, accessToken: "admin-access" };
    },
  });
  mockModule(t, "../src/services/sharekhanMarketData.service", {
    connectAdminMarketData: (value) => { connected = value; },
    marketDataStatus: () => ({ state: "connecting" }),
    closeSharekhanStreams: () => { connected = null; },
  });
  const controller = freshModule(t, "../src/controllers/sharekhanMarketData.controller");
  async function call(handler, body = {}, user = "admin-a") {
    const req = Readable.from([JSON.stringify(body)]);
    req.headers = { "content-type": "application/json" };
    req.user = { sub: user };
    let output;
    await handler(req, { writeHead() {}, end(value) { output = JSON.parse(value); } });
    return output;
  }
  const login = await call(controller.login, { apiKey: "admin-key", secureKey: "admin-secret" });
  assert.match(login.state, /^admin-feed-/);
  await assert.rejects(call(controller.complete, { state: login.state, requestToken: "request" }, "admin-b"));
  const completed = await call(controller.complete, { state: login.state, requestToken: "request" });
  assert.equal(completed.ok, true);
  assert.deepEqual(connected, { apiKey: "admin-key", accessToken: "admin-access", enabled: true });
  assert.equal(config.login, undefined);
  const status = await call(controller.status);
  assert.equal(status.hasCredentials, true);
  for (const response of [login, completed, status]) {
    assert.equal(JSON.stringify(response).includes("admin-secret"), false);
    assert.equal(JSON.stringify(response).includes("admin-access"), false);
  }
  await assert.rejects(call(controller.complete, { state: login.state, requestToken: "request" }));
  await call(controller.disconnect);
  assert.equal(config.enabled, false);
  assert.equal(connected, null);
});

test("all admin feed routes reject unauthenticated and regular user requests", async (t) => {
  const jwt = require("jsonwebtoken");
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "offline-admin-feed-test-secret";
  t.after(() => previous === undefined ? delete process.env.JWT_SECRET : process.env.JWT_SECRET = previous);
  const { registerV1Routes } = require("../src/routes/v1");
  const routes = [];
  registerV1Routes({ get: (path, handler) => routes.push({ path, handler }), post: (path, handler) => routes.push({ path, handler }) });
  const adminRoutes = routes.filter((route) => route.path.startsWith("/api/v1/admin/sharekhan-feed/"));
  assert.equal(adminRoutes.length, 5);
  const token = jwt.sign({ sub: "ordinary-user", role: "user" }, process.env.JWT_SECRET);
  for (const { handler } of adminRoutes) {
    await assert.rejects(handler({ headers: {} }, {}), /Unauthorized/);
    await assert.rejects(handler({ headers: { authorization: `Bearer ${token}` } }, {}), /Forbidden/);
  }
});
