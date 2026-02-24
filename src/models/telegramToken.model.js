const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function tokensCollection() {
  return getDb().collection("telegram_tokens");
}

async function createTokenRecord({ token, userId, expiresAt, createdAt }) {
  const payload = {
    token,
    userId: new ObjectId(userId),
    expiresAt,
    createdAt,
    usedAt: null,
    usedChatId: null,
  };
  await tokensCollection().insertOne(payload);
  return payload;
}

async function findTokenRecord(token) {
  return tokensCollection().findOne({ token });
}

async function markTokenUsed(token, chatId) {
  const now = new Date().toISOString();
  await tokensCollection().updateOne(
    { token },
    { $set: { usedAt: now, usedChatId: String(chatId) } }
  );
  return findTokenRecord(token);
}

async function listTokensByUser(userId, limit = 10) {
  return tokensCollection()
    .find({ userId: new ObjectId(userId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

async function listTokens(limit = 100) {
  return tokensCollection()
    .find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  tokensCollection,
  createTokenRecord,
  findTokenRecord,
  markTokenUsed,
  listTokensByUser,
  listTokens,
};
