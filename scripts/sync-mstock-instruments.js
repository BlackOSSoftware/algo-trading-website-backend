const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { connectMongo, closeMongo } = require("../src/config/db");
const {
  syncMStockInstrumentMaster,
  getMStockInstrumentCount,
  searchMStockInstruments,
} = require("../src/services/mstock.service");

async function main() {
  await connectMongo();
  console.log("Syncing mStock OpenAPIScripMaster into MongoDB...");
  const result = await syncMStockInstrumentMaster();
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
    return;
  }

  const total = await getMStockInstrumentCount();
  const sample = await searchMStockInstruments("REL", { limit: 5, exchange: "NSE" });
  console.log(
    JSON.stringify(
      {
        dbCount: total,
        sampleSearchREL: sample.map((item) => ({
          symbol: item.symbol,
          name: item.name,
          exchange: item.exchange,
          instrumentType: item.instrumentType,
          token: item.token,
        })),
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeMongo();
    } catch {}
  });
