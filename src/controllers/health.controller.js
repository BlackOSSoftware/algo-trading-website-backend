const os = require("os");
const { getDb } = require("../config/db");
const { sendJson } = require("../utils/response");
const pkg = require("../../package.json");

function toMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

async function health(req, res) {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  const memory = process.memoryUsage();
  const checks = {};
  let ok = true;

  const mongoCheck = { ok: false };
  try {
    const db = getDb();
    const pingStart = Date.now();
    await db.command({ ping: 1 });
    mongoCheck.ok = true;
    mongoCheck.latencyMs = Date.now() - pingStart;
  } catch (err) {
    ok = false;
    mongoCheck.error = err && err.message ? err.message : "MongoDB check failed";
  }
  checks.mongo = mongoCheck;

  const payload = {
    status: ok ? "ok" : "degraded",
    timestamp,
    uptimeSeconds: Math.floor(process.uptime()),
    responseTimeMs: Date.now() - startedAt,
    service: {
      name: pkg.name,
      version: pkg.version,
      environment: process.env.NODE_ENV || "development",
    },
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      memoryMb: {
        rss: toMb(memory.rss),
        heapTotal: toMb(memory.heapTotal),
        heapUsed: toMb(memory.heapUsed),
        external: toMb(memory.external),
      },
    },
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
    },
    checks,
  };

  const statusCode = ok ? 200 : 503;
  sendJson(res, statusCode, payload);
}

module.exports = { health };
