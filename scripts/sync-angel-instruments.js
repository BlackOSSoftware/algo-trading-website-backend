const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { connectMongo, closeMongo } = require("../src/config/db");
const { syncAngelInstruments } = require("../src/services/angelone.service");

async function main() {
  await connectMongo();
  const result = await syncAngelInstruments();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo().catch(() => {});
  });
