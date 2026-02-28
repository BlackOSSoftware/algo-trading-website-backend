const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function marketMayaTradesCollection() {
  return getDb().collection("marketmaya_trades");
}

function asObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const raw = String(value);
  return ObjectId.isValid(raw) ? new ObjectId(raw) : null;
}

function buildStrategyQuery(strategyId) {
  if (!strategyId) return null;
  const raw = strategyId instanceof ObjectId ? strategyId.toString() : String(strategyId);
  const id = ObjectId.isValid(raw) ? new ObjectId(raw) : null;
  return id ? { $or: [{ strategyId: id }, { strategyId: raw }] } : { strategyId: raw };
}

async function insertMarketMayaTrade(trade) {
  const payload = { ...trade };

  const userObj = asObjectId(payload.userId);
  if (userObj) payload.userId = userObj;

  const strategyObj = asObjectId(payload.strategyId);
  if (strategyObj) payload.strategyId = strategyObj;

  await marketMayaTradesCollection().insertOne(payload);
  return payload;
}

async function countTradesByStrategyInRange(strategyId, startIso, endIso, executeOnly = true) {
  const strategyQuery = buildStrategyQuery(strategyId);
  if (!strategyQuery) return 0;

  const rangeQuery = {};
  if (startIso || endIso) {
    rangeQuery.receivedAt = {};
    if (startIso) rangeQuery.receivedAt.$gte = startIso;
    if (endIso) rangeQuery.receivedAt.$lte = endIso;
  }

  const filters = [strategyQuery];
  if (rangeQuery.receivedAt) filters.push(rangeQuery);
  if (executeOnly) filters.push({ execute: true });

  const query = filters.length === 1 ? filters[0] : { $and: filters };
  return marketMayaTradesCollection().countDocuments(query);
}

module.exports = {
  marketMayaTradesCollection,
  insertMarketMayaTrade,
  countTradesByStrategyInRange,
};
