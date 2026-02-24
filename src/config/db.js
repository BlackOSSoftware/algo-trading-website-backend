const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "webhook_trigger_algo";

let client;
let db;

async function connectMongo() {
  if (db) return db;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);

  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("users").createIndex({ role: 1 });
  await db.collection("webhook_events").createIndex({ receivedAt: -1 });
  await db.collection("webhook_events").createIndex({ userId: 1, receivedAt: -1 });
  await db.collection("webhook_events").createIndex({
    strategyId: 1,
    receivedAt: -1,
  });
  await db.collection("strategies").createIndex({ userId: 1, createdAt: -1 });
  await db.collection("strategies").createIndex({ webhookKey: 1 }, { unique: true });
  await db.collection("marketmaya_trades").createIndex({ receivedAt: -1 });
  await db.collection("marketmaya_trades").createIndex({ userId: 1, receivedAt: -1 });
  await db.collection("marketmaya_trades").createIndex({ strategyId: 1, receivedAt: -1 });
  await db.collection("telegram_subscribers").createIndex({ chatId: 1 }, { unique: true });
  await db.collection("telegram_subscribers").createIndex({ active: 1, updatedAt: -1 });
  await db.collection("telegram_tokens").createIndex({ token: 1 }, { unique: true });
  await db.collection("telegram_tokens").createIndex({ userId: 1, createdAt: -1 });
  await db.collection("plans").createIndex({ name: 1 }, { unique: true });
  await db.collection("plans").createIndex({ active: 1 });
  await db.collection("plan_requests").createIndex({ userId: 1, createdAt: -1 });
  await db.collection("plan_requests").createIndex({ status: 1, createdAt: -1 });

  return db;
}

function getDb() {
  if (!db) {
    throw new Error("MongoDB not connected. Call connectMongo() first.");
  }
  return db;
}

async function closeMongo() {
  if (client) {
    await client.close();
  }
  client = undefined;
  db = undefined;
}

module.exports = { connectMongo, getDb, closeMongo };
