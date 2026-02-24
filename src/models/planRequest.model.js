const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function planRequestsCollection() {
  return getDb().collection("plan_requests");
}

async function findPendingPlanRequest(userId, planId) {
  return planRequestsCollection().findOne({
    userId: new ObjectId(userId),
    planId: new ObjectId(planId),
    status: "pending",
  });
}

async function createPlanRequest({ userId, planId }) {
  const now = new Date().toISOString();
  const request = {
    userId: new ObjectId(userId),
    planId: new ObjectId(planId),
    status: "pending",
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

async function listPlanRequestsByUser(userId) {
  return planRequestsCollection()
    .find({ userId: new ObjectId(userId) })
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

module.exports = {
  planRequestsCollection,
  createPlanRequest,
  findPendingPlanRequest,
  listPlanRequests,
  listPlanRequestsByStatus,
  findPlanRequestById,
  listPlanRequestsByUser,
  updatePlanRequestStatus,
};
