const { getDb } = require("../config/db");

function mstockConfigCollection() {
  return getDb().collection("mstock_config");
}

async function getGlobalMStockConfig() {
  return mstockConfigCollection().findOne({ _id: "global" });
}

async function upsertGlobalMStockConfig(patch) {
  const now = new Date().toISOString();
  const result = await mstockConfigCollection().findOneAndUpdate(
    { _id: "global" },
    {
      $set: {
        ...patch,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    {
      upsert: true,
      returnDocument: "after",
    }
  );

  if (!result) return null;
  return result.value ?? result;
}

module.exports = {
  getGlobalMStockConfig,
  upsertGlobalMStockConfig,
};
