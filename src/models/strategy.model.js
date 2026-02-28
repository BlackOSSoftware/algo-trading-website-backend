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

function buildUserQuery(userId) {
  if (!userId) return null;
  const raw = userId instanceof ObjectId ? userId.toString() : String(userId);
  const id = ObjectId.isValid(raw) ? new ObjectId(raw) : null;
  return id ? { $or: [{ userId: id }, { userId: raw }] } : { userId: raw };
}

function buildStrategyIdQuery(strategyId) {
  if (!strategyId) return null;
  const raw = strategyId instanceof ObjectId ? strategyId.toString() : String(strategyId);
  const id = ObjectId.isValid(raw) ? new ObjectId(raw) : null;
  return id ? { $or: [{ _id: id }, { _id: raw }] } : { _id: raw };
}

async function findStrategyByIdForUser(userId, strategyId) {
  const userQuery = buildUserQuery(userId);
  const idQuery = buildStrategyIdQuery(strategyId);
  if (!userQuery || !idQuery) return null;
  return strategiesCollection().findOne({ $and: [userQuery, idQuery] });
}

async function updateStrategyByIdForUser(userId, strategyId, patch) {
  const userQuery = buildUserQuery(userId);
  const idQuery = buildStrategyIdQuery(strategyId);
  if (!userQuery || !idQuery) return null;

  const result = await strategiesCollection().findOneAndUpdate(
    { $and: [userQuery, idQuery] },
    { $set: patch },
    { returnDocument: "after" }
  );

  if (!result) return null;
  return result.value ?? result;
}

async function deleteStrategyByIdForUser(userId, strategyId) {
  const userQuery = buildUserQuery(userId);
  const idQuery = buildStrategyIdQuery(strategyId);
  if (!userQuery || !idQuery) return null;

  const result = await strategiesCollection().findOneAndDelete({
    $and: [userQuery, idQuery],
  });

  if (!result) return null;
  return result.value ?? result;
}

module.exports = {
  strategiesCollection,
  insertStrategy,
  findStrategyByKey,
  findStrategiesByUser,
  listAllStrategies,
  findStrategyByIdForUser,
  updateStrategyByIdForUser,
  deleteStrategyByIdForUser,
};
