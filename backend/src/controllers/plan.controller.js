const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { listPlans, findPlanById } = require("../models/plan.model");
const {
  createPlanRequest,
  listPlanRequestsByUser,
  findPendingPlanRequest,
} = require("../models/planRequest.model");

async function list(req, res) {
  const plans = await listPlans(true);
  sendJson(res, 200, { ok: true, plans });
}

async function requestPlan(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const planId = body.planId;
  if (!planId) {
    throw createHttpError(400, "planId is required");
  }

  const plan = await findPlanById(planId);
  if (!plan || plan.active === false) {
    throw createHttpError(404, "Plan not found");
  }

  const existing = await findPendingPlanRequest(userId, planId);
  if (existing) {
    throw createHttpError(409, "Plan request already pending");
  }

  const request = await createPlanRequest({ userId, planId });
  sendJson(res, 201, { ok: true, request });
}

async function listUserRequests(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const requests = await listPlanRequestsByUser(userId);
  sendJson(res, 200, { ok: true, requests });
}

module.exports = {
  list,
  requestPlan,
  listUserRequests,
};
