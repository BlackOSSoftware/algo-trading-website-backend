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

async function insertMarketMayaTrade(trade) {
  const payload = { ...trade };

  const userObj = asObjectId(payload.userId);
  if (userObj) payload.userId = userObj;

  const strategyObj = asObjectId(payload.strategyId);
  if (strategyObj) payload.strategyId = strategyObj;

  await marketMayaTradesCollection().insertOne(payload);
  return payload;
}

module.exports = {
  marketMayaTradesCollection,
  insertMarketMayaTrade,
};

