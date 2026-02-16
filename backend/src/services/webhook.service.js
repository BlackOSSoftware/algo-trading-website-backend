const { insertWebhookEvent } = require("../models/webhookEvent.model");

async function saveWebhookEvent(event) {
  await insertWebhookEvent(event);
  return event;
}

module.exports = { saveWebhookEvent };
