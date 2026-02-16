const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const http = require("http");
const { createRouter } = require("./utils/router");
const { registerRoutes } = require("./routes");
const { notFound } = require("./middlewares/notFound");
const { errorHandler } = require("./middlewares/errorHandler");
const { connectMongo, closeMongo } = require("./config/db");
const { ensureAdminSeed } = require("./services/user.service");
const {
  syncTelegramWebhook,
} = require("./services/telegramWebhook.service");
const {
  startTelegramPolling,
  stopTelegramPolling,
} = require("./services/telegramPolling.service");

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

async function startServer() {
  await connectMongo();
  await ensureAdminSeed();
  await syncTelegramWebhook();
  startTelegramPolling();

  const router = createRouter();
  registerRoutes(router);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        notFound(req, res);
      }
    } catch (err) {
      errorHandler(err, req, res);
    }
  });

  server.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    stopTelegramPolling();
    await closeMongo();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
