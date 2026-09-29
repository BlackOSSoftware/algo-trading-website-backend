const { getDb } = require("../config/db");
// Separate collection: never read from or write to users/strategies.
const collection = () => getDb().collection("admin_sharekhan_market_data");
const ID = "price-feed";
const getMarketDataConfig = () => collection().findOne({ _id: ID });
const saveMarketDataConfig = (values) => collection().updateOne(
  { _id: ID }, { $set: { ...values, updatedAt: new Date().toISOString() } }, { upsert: true }
);
async function takeLoginPrep(userId, state) {
  return collection().findOneAndUpdate(
    { _id: ID, "login.userId": userId, "login.state": state, "login.expiresAt": { $gt: Date.now() } },
    { $unset: { login: "" } }, { returnDocument: "before" }
  );
}
module.exports = { getMarketDataConfig, saveMarketDataConfig, takeLoginPrep };
