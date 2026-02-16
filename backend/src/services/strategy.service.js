const {
  insertStrategy,
  findStrategiesByUser,
  findStrategyByKey,
} = require("../models/strategy.model");

async function createStrategy(strategy) {
  return insertStrategy(strategy);
}

async function listStrategies(userId) {
  return findStrategiesByUser(userId);
}

async function getStrategyByKey(webhookKey) {
  return findStrategyByKey(webhookKey);
}

module.exports = {
  createStrategy,
  listStrategies,
  getStrategyByKey,
};
