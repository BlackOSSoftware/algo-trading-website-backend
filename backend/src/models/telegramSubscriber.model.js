const { getDb } = require("../config/db");

function subscribersCollection() {
  return getDb().collection("telegram_subscribers");
}

async function upsertSubscriber({ chatId, firstName, username, userId }) {
  const now = new Date().toISOString();
  await subscribersCollection().updateOne(
    { chatId: String(chatId) },
    {
      $set: {
        chatId: String(chatId),
        userId: String(userId),
        firstName: firstName || "",
        username: username || "",
        active: true,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  );

  return subscribersCollection().findOne({ chatId: String(chatId) });
}

async function deactivateSubscriber(chatId) {
  const now = new Date().toISOString();
  await subscribersCollection().updateOne(
    { chatId: String(chatId) },
    { $set: { active: false, updatedAt: now } }
  );
  return subscribersCollection().findOne({ chatId: String(chatId) });
}

async function listActiveSubscribers() {
  return subscribersCollection().find({ active: true }).toArray();
}

async function listActiveSubscribersByUser(userId) {
  return subscribersCollection()
    .find({ active: true, userId: String(userId) })
    .toArray();
}

module.exports = {
  subscribersCollection,
  upsertSubscriber,
  deactivateSubscriber,
  listActiveSubscribers,
  listActiveSubscribersByUser,
};
