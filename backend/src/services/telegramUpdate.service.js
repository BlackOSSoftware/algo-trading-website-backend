const {
  subscribeChat,
  unsubscribeChat,
  sendTelegramText,
} = require("./telegram.service");
const {
  findTokenRecord,
  markTokenUsed,
} = require("../models/telegramToken.model");
const { findUserById, isPlanActive } = require("./user.service");

function extractMessage(update) {
  return (
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.edited_channel_post ||
    null
  );
}

async function processTelegramUpdate(update) {
  const message = extractMessage(update);
  if (!message) return { ok: true, ignored: true };

  const text = (message.text || "").trim();
  const chat = message.chat;

  if (!chat?.id) return { ok: true, ignored: true };

  if (text === "/start" || text.startsWith("/start ")) {
    await sendTelegramText(
      chat.id,
      "Welcome! To start alerts, send:\n/startAlert <token>\nTo stop: /stopAlert"
    );
    return { ok: true, action: "start_help" };
  }

  if (text.startsWith("/startAlert")) {
    const parts = text.split(" ");
    const token = parts[1];

    if (!token) {
      await sendTelegramText(
        chat.id,
        "Token missing. Use:\n/startAlert <token>"
      );
      return { ok: true, action: "missing_token" };
    }

    const tokenRecord = await findTokenRecord(token);
    if (!tokenRecord) {
      await sendTelegramText(
        chat.id,
        "Invalid token. Generate a new token from your dashboard."
      );
      return { ok: true, action: "invalid_token" };
    }

    if (tokenRecord.usedAt) {
      await sendTelegramText(
        chat.id,
        "Token already used. Generate a new token from your dashboard."
      );
      return { ok: true, action: "token_used" };
    }

    if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) <= new Date()) {
      await sendTelegramText(
        chat.id,
        "Token expired. Generate a new token from your dashboard."
      );
      return { ok: true, action: "token_expired" };
    }

    const user = await findUserById(tokenRecord.userId.toString());
    if (!user || !isPlanActive(user)) {
      await sendTelegramText(
        chat.id,
        "Your plan is inactive. Please renew your plan to receive alerts."
      );
      return { ok: true, action: "plan_inactive" };
    }

    await markTokenUsed(token, chat.id);
    await subscribeChat({
      chatId: chat.id,
      firstName: chat.first_name,
      username: chat.username,
      userId: user._id.toString(),
    });

    await sendTelegramText(
      chat.id,
      "Subscribed successfully. Your alerts are now started."
    );
    return { ok: true, action: "subscribed" };
  }

  if (text.startsWith("/stopAlert")) {
    await unsubscribeChat(chat.id);
    await sendTelegramText(
      chat.id,
      "Alerts stopped. You can start again with /startAlert <token>."
    );
    return { ok: true, action: "stopped" };
  }

  return { ok: true, ignored: true };
}

module.exports = { processTelegramUpdate };
