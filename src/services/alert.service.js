const { findEventsByUser } = require("../models/webhookEvent.model");

async function listAlerts(userId, strategyId, limit) {
  return findEventsByUser(userId, strategyId, limit);
}

module.exports = { listAlerts };
