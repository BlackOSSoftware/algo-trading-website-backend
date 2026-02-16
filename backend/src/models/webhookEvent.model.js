const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function webhookEventsCollection() {
  return getDb().collection("webhook_events");
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

module.exports = {
  webhookEventsCollection,
  insertWebhookEvent,
  findEventsByUser,
};
