const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function usersCollection() {
  return getDb().collection("users");
}

async function findUserByEmail(email) {
  if (!email) return null;
  return usersCollection().findOne({ email: email.toLowerCase() });
}

async function findUserById(id) {
  if (!id) return null;
  return usersCollection().findOne({ _id: new ObjectId(id) });
}

async function createUser({
  name,
  email,
  passwordHash,
  role,
  planName,
  planExpiresAt,
}) {
  const now = new Date().toISOString();
  const user = {
    name,
    email: email.toLowerCase(),
    passwordHash,
    role,
    planName: planName || null,
    planExpiresAt: planExpiresAt || null,
    createdAt: now,
  };

  const result = await usersCollection().insertOne(user);
  return { _id: result.insertedId, ...user };
}

async function updateUserById(id, update) {
  if (!id) return null;
  await usersCollection().updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );
  return findUserById(id);
}

module.exports = {
  usersCollection,
  findUserByEmail,
  findUserById,
  createUser,
  updateUserById,
};
