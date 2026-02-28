const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function planRequestsCollection() {
  return getDb().collection("plan_requests");
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const raw = String(value);
  if (!ObjectId.isValid(raw)) return null;
  return new ObjectId(raw);
}

async function findPendingPlanRequest(userId, planId) {
  const userObjectId = toObjectId(userId);
  const planObjectId = toObjectId(planId);
  if (!userObjectId || !planObjectId) return null;
  return planRequestsCollection().findOne({
    userId: userObjectId,
    planId: planObjectId,
    status: "pending",
  });
}

async function findOpenPlanRequest(userId, planId) {
  const userObjectId = toObjectId(userId);
  const planObjectId = toObjectId(planId);
  if (!userObjectId || !planObjectId) return null;
  return planRequestsCollection().findOne({
    userId: userObjectId,
    planId: planObjectId,
    status: { $in: ["pending", "paid"] },
    isProcessed: { $ne: true },
    razorpayOrderId: { $nin: [null, ""] },
  });
}

async function createPlanRequest({
  userId,
  planId,
  amount,
  status = "pending",
  razorpayOrderId = null,
  razorpayPaymentId = null,
  razorpaySignature = null,
  startDate = null,
  endDate = null,
  isProcessed = false,
}) {
  const now = new Date().toISOString();
  const request = {
    userId: new ObjectId(userId),
    planId: new ObjectId(planId),
    amount: Number(amount || 0),
    status,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    startDate,
    endDate,
    isProcessed,
    createdAt: now,
    updatedAt: now,
  };
  const result = await planRequestsCollection().insertOne(request);
  return { _id: result.insertedId, ...request };
}

async function listPlanRequests() {
  return planRequestsCollection().find().sort({ createdAt: -1 }).toArray();
}

async function listPlanRequestsByStatus(status) {
  return planRequestsCollection()
    .find({ status })
    .sort({ createdAt: -1 })
    .toArray();
}

async function findPlanRequestById(id) {
  if (!id) return null;
  return planRequestsCollection().findOne({ _id: new ObjectId(id) });
}

async function findPlanRequestByOrderId(orderId) {
  if (!orderId) return null;
  return planRequestsCollection().findOne({ razorpayOrderId: orderId });
}

async function listPlanRequestsByUser(userId) {
  const userObjectId = toObjectId(userId);
  if (!userObjectId) return [];
  return planRequestsCollection()
    .find({ userId: userObjectId })
    .sort({ createdAt: -1 })
    .toArray();
}

async function updatePlanRequestStatus(id, status) {
  const now = new Date().toISOString();
  await planRequestsCollection().updateOne(
    { _id: new ObjectId(id) },
    { $set: { status, updatedAt: now } }
  );
  return planRequestsCollection().findOne({ _id: new ObjectId(id) });
}

async function updatePlanRequestById(id, patch) {
  if (!id || !patch) return null;
  const now = new Date().toISOString();
  await planRequestsCollection().updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...patch, updatedAt: now } }
  );
  return planRequestsCollection().findOne({ _id: new ObjectId(id) });
}

async function updatePlanRequestByOrderId(orderId, patch) {
  if (!orderId || !patch) return null;
  const now = new Date().toISOString();
  await planRequestsCollection().updateOne(
    { razorpayOrderId: orderId },
    { $set: { ...patch, updatedAt: now } }
  );
  return planRequestsCollection().findOne({ razorpayOrderId: orderId });
}

module.exports = {
  planRequestsCollection,
  createPlanRequest,
  findPendingPlanRequest,
  findOpenPlanRequest,
  listPlanRequests,
  listPlanRequestsByStatus,
  findPlanRequestById,
  findPlanRequestByOrderId,
  listPlanRequestsByUser,
  updatePlanRequestStatus,
  updatePlanRequestById,
  updatePlanRequestByOrderId,
};
