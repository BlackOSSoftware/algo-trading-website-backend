const {
  insertStrategy,
  findStrategiesByUser,
  findStrategyByKey,
  findStrategyByIdForUser,
  updateStrategyByIdForUser,
  deleteStrategyByIdForUser,
} = require("../models/strategy.model");
const { deleteEventsByUserAndStrategy } = require("../models/webhookEvent.model");

async function createStrategy(strategy) {
  return insertStrategy(strategy);
}

async function listStrategies(userId) {
  return findStrategiesByUser(userId);
}

async function getStrategyByKey(webhookKey) {
  return findStrategyByKey(webhookKey);
}

async function getStrategyByIdForUser(userId, strategyId) {
  return findStrategyByIdForUser(userId, strategyId);
}

async function updateStrategy(userId, strategyId, patch) {
  return updateStrategyByIdForUser(userId, strategyId, patch);
}

async function deleteStrategy(userId, strategyId) {
  const deleted = await deleteStrategyByIdForUser(userId, strategyId);
  if (deleted) {
    await deleteEventsByUserAndStrategy(userId, deleted._id);
  }
  return deleted;
}

module.exports = {
  createStrategy,
  listStrategies,
  getStrategyByKey,
  getStrategyByIdForUser,
  updateStrategy,
  deleteStrategy,
};
