const {
  upsertSubscriber,
  deactivateSubscriber,
  listActiveSubscribers,
  listActiveSubscribersByUser,
} = require("../models/telegramSubscriber.model");
const { createHttpError } = require("../utils/httpError");

function formatMessage({ strategyName, payload, receivedAt }) {
  const alertName = payload?.alert_name || payload?.alertName || "Alert";
  const scanName = payload?.scan_name || payload?.scanName || "Chartink";
  const triggeredAt = payload?.triggered_at || payload?.triggeredAt || "";
  const stocks = payload?.stocks || "";
  const stockCount = stocks
    ? String(stocks).split(",").filter(Boolean).length
    : null;

  return [
    `ALERT: ${alertName}`,
    `Strategy: ${strategyName}`,
    `Scan: ${scanName}`,
    triggeredAt ? `Triggered: ${triggeredAt}` : null,
    stockCount ? `Stocks: ${stockCount}` : null,
    `Received: ${receivedAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function postTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !text) return;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    let errorMessage = "Telegram send failed";
    try {
      const data = await response.json();
      errorMessage = data.description || JSON.stringify(data);
    } catch (err) {
      errorMessage = await response.text();
    }
    throw createHttpError(400, errorMessage || "Telegram send failed");
  }
}

async function sendTelegramMessage(chatId, details) {
  const message = formatMessage(details);
  return postTelegramMessage(chatId, message);
}

async function sendTelegramText(chatId, text) {
  return postTelegramMessage(chatId, text);
}

async function subscribeChat(chat) {
  return upsertSubscriber(chat);
}

async function unsubscribeChat(chatId) {
  return deactivateSubscriber(chatId);
}

async function getActiveSubscribers() {
  return listActiveSubscribers();
}

async function getActiveSubscribersForUser(userId) {
  return listActiveSubscribersByUser(userId);
}

module.exports = {
  sendTelegramMessage,
  sendTelegramText,
  subscribeChat,
  unsubscribeChat,
  getActiveSubscribers,
  getActiveSubscribersForUser,
};
