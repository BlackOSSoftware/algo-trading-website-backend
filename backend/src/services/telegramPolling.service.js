const { processTelegramUpdate } = require("./telegramUpdate.service");

let polling = false;
let lastUpdateId = 0;
let lastPollAt = null;
let lastPollError = null;

function shouldPoll() {
  return process.env.TELEGRAM_POLLING === "true";
}

async function disableWebhook(token) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "" }),
    });
  } catch (err) {
    // ignore
  }
}

async function pollOnce(token) {
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${lastUpdateId + 1}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  lastPollAt = new Date().toISOString();

  if (!data.ok || !Array.isArray(data.result)) {
    lastPollError = data?.description || "getUpdates failed";
    return;
  }

  for (const update of data.result) {
    if (typeof update.update_id === "number") {
      lastUpdateId = update.update_id;
    }
    try {
      await processTelegramUpdate(update);
    } catch (err) {
      // ignore individual update errors
    }
  }

  lastPollError = null;
}

async function startTelegramPolling() {
  if (!shouldPoll() || polling) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  polling = true;
  await disableWebhook(token);

  while (polling) {
    try {
      await pollOnce(token);
    } catch (err) {
      lastPollError = err instanceof Error ? err.message : "Polling error";
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function stopTelegramPolling() {
  polling = false;
}

module.exports = {
  startTelegramPolling,
  stopTelegramPolling,
  getPollingStatus: () => ({
    enabled: shouldPoll(),
    active: polling,
    lastPollAt,
    lastError: lastPollError,
    lastUpdateId,
  }),
};
