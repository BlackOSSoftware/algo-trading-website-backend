const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { listAlerts, clearAlerts } = require("../services/alert.service");

async function list(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const params = req.parsedUrl?.searchParams;
  const strategyId = params ? params.get("strategyId") : null;
  const limitRaw = params ? params.get("limit") : null;
  const limit = limitRaw ? Math.min(Number(limitRaw) || 50, 200) : 50;

  const alerts = await listAlerts(userId, strategyId, limit);
  sendJson(res, 200, { ok: true, alerts });
}

async function clear(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const result = await clearAlerts(userId);
  sendJson(res, 200, { ok: true, deletedCount: result.deletedCount || 0 });
}

module.exports = { list, clear };
