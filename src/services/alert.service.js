const {
  findEventsByUser,
  deleteEventsByUser,
} = require("../models/webhookEvent.model");

async function listAlerts(userId, strategyId, limit) {
  return findEventsByUser(userId, strategyId, limit);
}

async function clearAlerts(userId) {
  return deleteEventsByUser(userId);
}

module.exports = { listAlerts, clearAlerts };
