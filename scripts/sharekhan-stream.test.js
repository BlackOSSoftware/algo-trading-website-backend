const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SharekhanStream } = require("../src/services/sharekhanStream.service");

function setup(t) {
  const sockets = [];
  const stream = new SharekhanStream({ apiKey: "key", accessToken: "token",
    socketFactory: (url) => {
      const socket = new EventEmitter();
      socket.url = url;
      socket.sent = [];
      socket.send = (data) => socket.sent.push(JSON.parse(data));
      socket.terminate = () => socket.emit("close");
      socket.ping = () => socket.emit("pong");
      sockets.push(socket);
      return socket;
    } });
  t.after(() => stream.dispose());
  return { stream, sockets };
}

function ready(socket, acknowledgement = "success FEED") {
  socket.emit("message", JSON.stringify({ status: 100, message: "connect" }));
  socket.emit("message", JSON.stringify({ status: 100, message: "subscribe", data: acknowledgement }));
}

function tick(socket, data = {}, timestamp = new Date().toISOString()) {
  socket.emit("message", JSON.stringify({ status: 100, message: "feed", timestamp,
    data: { exchangeCode: "NC", scripCode: 22, ltp: 123.45, ...data } }));
}

test("accepts broker month/day dates including ambiguous days; rejects invalid and stale dates", async (t) => {
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  const { stream, sockets } = setup(t);
  Date.now = () => Date.parse("2026-09-29T14:51:35+05:30");
  const result = stream.getPrice("NC", "2475");
  ready(sockets[0]);
  assert.equal(stream.ready, true);
  for (const lastUpdatedTime of ["02/30/2026 14:51:35", "09/29/2026 14:50:00", "29/09/2026 14:51:35"]) {
    tick(sockets[0], { scripCode: 2475, lastUpdatedTime });
    assert.equal(stream.pending.size, 1);
  }
  tick(sockets[0], { scripCode: 2475, ltp: 230.3, lastUpdatedTime: "09/29/2026 14:51:35" });
  assert.equal((await result).result.timestamp, "2026-09-29T09:21:35.000Z");
  Date.now = () => Date.parse("2026-10-09T14:51:35+05:30");
  const next = stream.getPrice("NC", "2475");
  tick(sockets[0], { scripCode: 2475, lastUpdatedTime: "10/09/2026 14:51:35" });
  assert.equal((await next).result.timestamp, "2026-10-09T09:21:35.000Z");
});

test("also accepts compact feed acknowledgement", (t) => {
  const { stream, sockets } = setup(t);
  stream.connect();
  ready(sockets[0], "successFEED");
  assert.equal(stream.ready, true);
});

test("authenticates, subscribes after acknowledgement, routes concurrent instrument ticks", async (t) => {
  const { stream, sockets } = setup(t);
  const first = stream.getPrice("NC", "22");
  const second = stream.getPrice("NF", "22");
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.equal(new URL(socket.url).searchParams.get("API_KEY"), "key");
  assert.equal(socket.sent.length, 0);
  ready(socket);
  assert.deepEqual(socket.sent, [
    { action: "subscribe", key: ["feed"], value: [""] },
    { action: "feed", key: ["ltp"], value: ["NC22,NF22"] },
  ]);
  tick(socket);
  assert.equal((await first).price, "123.45");
  assert.equal(stream.pending.has("NF22"), true);
  tick(socket, { exchangeCode: "NF", ltp: 44 });
  assert.equal((await second).price, "44");
});

test("ignores malformed, wrong instrument, invalid and stale ticks; reuses only fresh cached prices", async (t) => {
  const { stream, sockets } = setup(t);
  const result = stream.getPrice("NC", "22");
  const socket = sockets[0];
  ready(socket);
  socket.emit("message", "invalid JSON");
  tick(socket, { scripCode: 23 });
  tick(socket, { ltp: 0, close: 999 });
  tick(socket, {}, "2021-01-01T00:00:00Z");
  tick(socket, { lastUpdatedTime: "01/01/2021 12:00:00" });
  assert.equal(stream.pending.size, 1);
  tick(socket);
  assert.equal((await result).ok, true);
  assert.equal((await stream.getPrice("NC", "22")).price, "123.45");
  stream.quotes.get("NC22").result.timestamp = "2021-01-01T00:00:00Z";
  const next = stream.getPrice("NC", "22");
  assert.equal(stream.pending.size, 1);
  tick(socket, { ltp: 124 });
  assert.equal((await next).price, "124");
});

test("times out without a usable tick", async (t) => {
  const previous = process.env.SHAREKHAN_WS_PRICE_TIMEOUT_MS;
  process.env.SHAREKHAN_WS_PRICE_TIMEOUT_MS = "20";
  t.after(() => previous === undefined ? delete process.env.SHAREKHAN_WS_PRICE_TIMEOUT_MS : process.env.SHAREKHAN_WS_PRICE_TIMEOUT_MS = previous);
  const { stream } = setup(t);
  const result = await stream.getPrice("NC", "22");
  assert.equal(result.ok, false);
  assert.match(result.error, /No fresh/);
  assert.equal(stream.pending.size, 0);
});

test("reconnects and resubscribes without submitting any orders", async (t) => {
  const { stream, sockets } = setup(t);
  const result = stream.getPrice("NC", "22");
  ready(sockets[0]);
  sockets[0].terminate();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(sockets.length, 2);
  ready(sockets[1]);
  assert.equal(sockets[1].sent[1].value[0], "NC22");
  tick(sockets[1]);
  assert.equal((await result).ok, true);
});

test("authentication failure and shutdown release pending requests", async (t) => {
  const { stream, sockets } = setup(t);
  const result = stream.getPrice("NC", "22");
  sockets[0].emit("message", JSON.stringify({ status: 401, message: "invalid token" }));
  assert.equal((await result).expired, true);
  assert.equal(stream.closed, true);
  assert.equal(stream.reconnectTimer, undefined);
});

test("live order uses stream price despite incoming price; failed lookup sends no HTTP order", async (t) => {
  const modelPath = require.resolve("../src/models/mstockInstrument.model");
  const streamPath = require.resolve("../src/services/sharekhanMarketData.service");
  const servicePath = require.resolve("../src/services/sharekhan.service");
  const oldModel = require.cache[modelPath];
  const oldStream = require.cache[streamPath];
  const oldService = require.cache[servicePath];
  const oldFetch = global.fetch;
  t.after(() => {
    for (const [path, original] of [[modelPath, oldModel], [streamPath, oldStream], [servicePath, oldService]]) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
    global.fetch = oldFetch;
  });
  let lookup = { ok: true, price: "123.45", source: "sharekhanWebSocketLtp" };
  require.cache[modelPath] = { exports: { resolveInstrumentForOrder: async () => ({ token: "22", symbol: "TEST", exchange: "NSE" }) } };
  require.cache[streamPath] = { exports: { getSharekhanStreamPrice: async (input) => {
    assert.deepEqual(input, { exchange: "NC", scripCode: "22" });
    return lookup;
  } } };
  delete require.cache[servicePath];
  const { placeSharekhanOrder } = require(servicePath);
  const bodies = [];
  global.fetch = async (_url, options) => {
    assert.equal(options.headers["api-key"], "key");
    assert.equal(options.headers["access-token"], "token");
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => '{"data":{"orderId":"test-order"}}' };
  };
  const args = { apiKey: "key", accessToken: "token", customerId: "123", execute: true,
    exchange: "NSE", segment: "EQ", symbol: "TEST", callType: "BUY", quantity: "1", price: "99" };
  await placeSharekhanOrder(args);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].price, "123.45");
  lookup = { ok: false, error: "No fresh tick" };
  const failed = await placeSharekhanOrder(args);
  assert.equal(failed.ok, false);
  assert.equal(bodies.length, 1);
});
