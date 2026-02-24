const {
  insertWebhookEvent,
  updateWebhookEventById,
} = require("../models/webhookEvent.model");

async function saveWebhookEvent(event) {
  await insertWebhookEvent(event);
  return event;
}

async function updateWebhookEvent(eventId, patch) {
  return updateWebhookEventById(eventId, patch);
}

module.exports = { saveWebhookEvent, updateWebhookEvent };
