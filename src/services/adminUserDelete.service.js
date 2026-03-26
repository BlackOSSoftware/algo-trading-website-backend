const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function asObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const raw = String(value).trim();
  return ObjectId.isValid(raw) ? new ObjectId(raw) : null;
}

function buildFieldQuery(field, value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const objectId = asObjectId(raw);
  return objectId ? { $or: [{ [field]: objectId }, { [field]: raw }] } : { [field]: raw };
}

function buildFieldInQuery(field, values) {
  const rawValues = Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
  if (rawValues.length === 0) return null;

  const objectIds = rawValues.map((value) => asObjectId(value)).filter(Boolean);
  const clauses = [];

  if (objectIds.length > 0) {
    clauses.push({ [field]: { $in: objectIds } });
  }
  if (rawValues.length > 0) {
    clauses.push({ [field]: { $in: rawValues } });
  }

  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
}

function mergeQueries(queries) {
  const items = (queries || []).filter(Boolean);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return { $or: items };
}

function sanitizeDeletedUser(user) {
  if (!user) return null;
  return {
    id: user._id?.toString ? user._id.toString() : String(user._id || ""),
    name: user.name || "",
    email: user.email || "",
    role: user.role || "",
    planName: user.planName || null,
  };
}

async function deleteUserCascade(userId) {
  const db = getDb();
  const userObjectId = asObjectId(userId);
  if (!userObjectId) {
    return null;
  }

  const user = await db.collection("users").findOne({ _id: userObjectId });
  if (!user) {
    return null;
  }

  const userQuery = buildFieldQuery("userId", userObjectId);
  const strategies = await db
    .collection("strategies")
    .find(userQuery || { _id: null })
    .project({ _id: 1 })
    .toArray();

  const strategyIds = strategies
    .map((item) => item?._id?.toString ? item._id.toString() : String(item?._id || ""))
    .filter(Boolean);

  const strategyQuery = buildFieldInQuery("strategyId", strategyIds);
  const linkedEventQuery = mergeQueries([userQuery, strategyQuery]);
  const counts = {};

  counts.webhookEvents = linkedEventQuery
    ? (await db.collection("webhook_events").deleteMany(linkedEventQuery)).deletedCount || 0
    : 0;
  counts.marketMayaTrades = linkedEventQuery
    ? (await db.collection("marketmaya_trades").deleteMany(linkedEventQuery)).deletedCount || 0
    : 0;
  counts.planRequests = userQuery
    ? (await db.collection("plan_requests").deleteMany(userQuery)).deletedCount || 0
    : 0;
  counts.telegramTokens = userQuery
    ? (await db.collection("telegram_tokens").deleteMany(userQuery)).deletedCount || 0
    : 0;
  counts.telegramSubscribers = userQuery
    ? (await db.collection("telegram_subscribers").deleteMany(userQuery)).deletedCount || 0
    : 0;
  counts.strategies = userQuery
    ? (await db.collection("strategies").deleteMany(userQuery)).deletedCount || 0
    : 0;
  counts.users = (await db.collection("users").deleteOne({ _id: userObjectId })).deletedCount || 0;

  const linkedRecordsDeleted =
    counts.webhookEvents +
    counts.marketMayaTrades +
    counts.planRequests +
    counts.telegramTokens +
    counts.telegramSubscribers +
    counts.strategies;

  return {
    user: sanitizeDeletedUser(user),
    counts,
    linkedRecordsDeleted,
    totalDeleted: linkedRecordsDeleted + counts.users,
  };
}

module.exports = {
  deleteUserCascade,
};
