const crypto = require("crypto");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { listPlans, findPlanById } = require("../models/plan.model");
const {
  createPlanRequest,
  listPlanRequestsByUser,
  findPendingPlanRequest,
  findOpenPlanRequest,
  findPlanRequestByOrderId,
  updatePlanRequestById,
} = require("../models/planRequest.model");
const { findUserById } = require("../services/user.service");

function getRazorpayConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw createHttpError(500, "Razorpay credentials are not configured");
  }
  return { keyId, keySecret };
}

function isPlanActiveForUser(user) {
  if (!user?.planExpiresAt) return false;
  const expiresAt = new Date(user.planExpiresAt).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > Date.now();
}

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

  const request = await createPlanRequest({
    userId,
    planId,
    amount: Number(plan.price || 0),
    status: "pending",
  });
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

async function createPlanOrder(req, res) {
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

  const user = await findUserById(userId);
  if (!user) {
    throw createHttpError(404, "User not found");
  }

  if (isPlanActiveForUser(user)) {
    const currentPlan = String(user.planName || "").trim().toLowerCase();
    const nextPlan = String(plan.name || "").trim().toLowerCase();
    if (currentPlan && nextPlan && currentPlan === nextPlan) {
      throw createHttpError(409, "Active plan already exists");
    }
  }

  const openRequest = await findOpenPlanRequest(userId, planId);
  if (openRequest) {
    throw createHttpError(409, "Plan purchase already in progress");
  }

  const amount = Number(plan.price || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createHttpError(400, "Invalid plan amount");
  }

  const request = await createPlanRequest({
    userId,
    planId,
    amount,
    status: "pending",
  });

  const { keyId, keySecret } = getRazorpayConfig();
  const orderPayload = {
    amount: Math.round(amount * 100),
    currency: "INR",
    receipt: request._id.toString(),
    notes: {
      userId: userId.toString(),
      planId: planId.toString(),
    },
  };

  let orderData;
  try {
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
      },
      body: JSON.stringify(orderPayload),
    });

    orderData = await response.json().catch(() => ({}));
    if (!response.ok) {
      await updatePlanRequestById(request._id, { status: "failed" });
      throw createHttpError(400, orderData?.error?.description || "Order creation failed");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Order")) {
      throw err;
    }
    await updatePlanRequestById(request._id, { status: "failed" });
    throw createHttpError(500, "Unable to create Razorpay order");
  }

  if (!orderData?.id) {
    await updatePlanRequestById(request._id, { status: "failed" });
    throw createHttpError(500, "Razorpay order id missing");
  }

  const updated = await updatePlanRequestById(request._id, {
    razorpayOrderId: orderData.id,
  });

  sendJson(res, 200, {
    ok: true,
    order: {
      id: orderData.id,
      amount: orderData.amount,
      currency: orderData.currency,
      receipt: orderData.receipt,
    },
    plan: {
      id: plan._id?.toString ? plan._id.toString() : plan._id,
      name: plan.name,
      price: plan.price,
      durationDays: plan.durationDays,
    },
    request: {
      id: updated?._id?.toString ? updated._id.toString() : request._id.toString(),
      status: updated?.status || request.status,
    },
    keyId,
  });
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function verifyPlanPayment(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const orderId = body.razorpay_order_id || body.razorpayOrderId;
  const paymentId = body.razorpay_payment_id || body.razorpayPaymentId;
  const signature = body.razorpay_signature || body.razorpaySignature;

  if (!orderId || !paymentId || !signature) {
    throw createHttpError(400, "Payment verification fields are required");
  }

  const { keySecret } = getRazorpayConfig();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  if (!safeEqual(expected, signature)) {
    throw createHttpError(400, "Invalid payment signature");
  }

  const request = await findPlanRequestByOrderId(orderId);
  if (!request) {
    throw createHttpError(404, "Plan request not found");
  }
  if (request.userId && request.userId.toString && request.userId.toString() !== String(userId)) {
    throw createHttpError(403, "Not allowed");
  }

  if (request.status === "paid" || request.status === "active") {
    sendJson(res, 200, { ok: true, status: request.status });
    return;
  }

  const updated = await updatePlanRequestById(request._id, {
    status: "paid",
    razorpayPaymentId: paymentId,
    razorpaySignature: signature,
  });

  sendJson(res, 200, { ok: true, status: updated?.status || "paid" });
}

module.exports = {
  list,
  requestPlan,
  listUserRequests,
  createPlanOrder,
  verifyPlanPayment,
};
