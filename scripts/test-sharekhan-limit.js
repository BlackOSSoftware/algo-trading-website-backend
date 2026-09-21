const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");
const { connectMongo, closeMongo } = require("../src/config/db");
const { placeSharekhanOrder } = require("../src/services/sharekhan.service");

(async () => {
  await connectMongo();
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "webhook_trigger_algo";
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const user = await db.collection("users").findOne(
    { "sharekhan.accessToken": { $exists: true, $nin: [null, ""] } },
    { projection: { email: 1, sharekhan: 1 } }
  );
  if (!user?.sharekhan?.accessToken) {
    console.log(JSON.stringify({ ok: false, error: "No sharekhan user found" }));
    process.exit(1);
  }
  const sk = user.sharekhan;
  console.log("USER", user.email || String(user._id));

  const common = {
    apiKey: sk.apiKey,
    accessToken: sk.accessToken,
    customerId: sk.customerId,
    channelUser: sk.channelUser || sk.customerId,
    exchange: "NSE",
    segment: "EQ",
    symbol: "ONGC",
    callType: "BUY",
    quantity: "1",
    productType: sk.productType || "INVESTMENT",
    orderType: "NORMAL",
    price: "",
  };

  const preview = await placeSharekhanOrder({ ...common, execute: false });
  console.log(
    "PREVIEW",
    JSON.stringify(
      {
        ok: preview.ok,
        dryRun: preview.dryRun,
        error: preview.error || null,
        price: preview.preview?.price || null,
        orderType: preview.preview?.orderType || null,
        body: preview.preview || null,
      },
      null,
      2
    )
  );

  if (preview.error && !preview.ok) {
    await client.close();
    await closeMongo();
    process.exit(2);
  }

  if (process.env.SHAREKHAN_TEST_EXECUTE !== "true") {
    console.log("LIVE", JSON.stringify({ skipped: true, reason: "Set SHAREKHAN_TEST_EXECUTE=true to send a real order" }));
    await client.close();
    await closeMongo();
    return;
  }

  const live = await placeSharekhanOrder({ ...common, execute: true });
  console.log(
    "LIVE",
    JSON.stringify(
      {
        ok: live.ok,
        dryRun: live.dryRun,
        error: live.error || null,
        status: live.status || null,
        orderId:
          live.orderId ||
          live.result?.orderId ||
          live.response?.payload?.orderId ||
          live.response?.payload?.data?.orderId ||
          null,
        price: live.request?.price || common.price,
        payload: live.response?.payload || live.result || live.response || null,
      },
      null,
      2
    )
  );
  await client.close();
  await closeMongo();
})().catch(async (error) => {
  console.error("FATAL", error.message);
  try {
    await closeMongo();
  } catch {}
  process.exit(1);
});
