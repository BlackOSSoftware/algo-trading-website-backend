const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function strategiesCollection() {
  return getDb().collection("strategies");
}

async function insertStrategy(strategy) {
  const payload = {
    ...strategy,
    userId: new ObjectId(strategy.userId),
  };
  const result = await strategiesCollection().insertOne(payload);
  return { _id: result.insertedId, ...payload };
}

async function findStrategyByKey(webhookKey) {
  if (!webhookKey) return null;
  return strategiesCollection().findOne({ webhookKey });
}

async function findStrategiesByUser(userId) {
  if (!userId) return [];
  const query = ObjectId.isValid(userId)
    ? { $or: [{ userId: new ObjectId(userId) }, { userId }] }
    : { userId };

  return strategiesCollection().find(query).sort({ createdAt: -1 }).toArray();
}

async function listAllStrategies() {
  return strategiesCollection().find().sort({ createdAt: -1 }).toArray();
}

module.exports = {
  strategiesCollection,
  insertStrategy,
  findStrategyByKey,
  findStrategiesByUser,
  listAllStrategies,
};
