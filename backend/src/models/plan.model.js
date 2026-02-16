const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

function plansCollection() {
  return getDb().collection("plans");
}

async function createPlan({ name, price, durationDays, active }) {
  const now = new Date().toISOString();
  const plan = {
    name,
    price,
    durationDays,
    active: active !== false,
    createdAt: now,
  };
  const result = await plansCollection().insertOne(plan);
  return { _id: result.insertedId, ...plan };
}

async function listPlans(activeOnly = false) {
  const query = activeOnly ? { active: true } : {};
  return plansCollection().find(query).sort({ createdAt: -1 }).toArray();
}

async function findPlanById(id) {
  if (!id) return null;
  return plansCollection().findOne({ _id: new ObjectId(id) });
}

async function findPlanByName(name) {
  if (!name) return null;
  return plansCollection().findOne({ name });
}

module.exports = {
  plansCollection,
  createPlan,
  listPlans,
  findPlanById,
  findPlanByName,
};
