const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function webhookEventsCollection() {
  return getDb().collection("webhook_events");
}

async function findWebhookEventById(eventId) {
  if (!eventId) return null;
  return webhookEventsCollection().findOne({ id: String(eventId) });
}

async function insertWebhookEvent(event) {
  const payload = { ...event };
  if (payload.userId) {
    payload.userId = new ObjectId(payload.userId);
  }
  if (payload.strategyId) {
    payload.strategyId = new ObjectId(payload.strategyId);
  }

  await webhookEventsCollection().insertOne(payload);
  return payload;
}

async function updateWebhookEventById(eventId, patch) {
  if (!eventId || !patch) return null;
  return webhookEventsCollection().updateOne(
    { id: String(eventId) },
    { $set: patch }
  );
}

async function findEventsByUser(userId, strategyId, limit = 50) {
  if (!userId) return [];
  const userQuery = ObjectId.isValid(userId)
    ? { $or: [{ userId: new ObjectId(userId) }, { userId }] }
    : { userId };
  if (strategyId) {
    const strategyQuery = ObjectId.isValid(strategyId)
      ? { $or: [{ strategyId: new ObjectId(strategyId) }, { strategyId }] }
      : { strategyId };
    return webhookEventsCollection()
      .find({ $and: [userQuery, strategyQuery] })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .toArray();
  }

  return webhookEventsCollection()
    .find(userQuery)
    .sort({ receivedAt: -1 })
    .limit(limit)
    .toArray();
}

async function deleteEventsByUserAndStrategy(userId, strategyId) {
  if (!userId || !strategyId) return { deletedCount: 0 };

  const userRaw = userId instanceof ObjectId ? userId.toString() : String(userId);
  const userObj = ObjectId.isValid(userRaw) ? new ObjectId(userRaw) : null;
  const userQuery = userObj
    ? { $or: [{ userId: userObj }, { userId: userRaw }] }
    : { userId: userRaw };

  const raw = strategyId instanceof ObjectId ? strategyId.toString() : String(strategyId);
  const id = ObjectId.isValid(raw) ? new ObjectId(raw) : null;
  const strategyQuery = id
    ? { $or: [{ strategyId: id }, { strategyId: raw }] }
    : { strategyId: raw };

  return webhookEventsCollection().deleteMany({ $and: [userQuery, strategyQuery] });
}

module.exports = {
  webhookEventsCollection,
  findWebhookEventById,
  insertWebhookEvent,
  updateWebhookEventById,
  findEventsByUser,
  deleteEventsByUserAndStrategy,
};
