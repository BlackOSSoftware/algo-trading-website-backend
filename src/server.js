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
const CORS_ALLOW_CREDENTIALS = process.env.CORS_ALLOW_CREDENTIALS === "true";

function setCorsHeaders(req, res) {
  const requestOrigin = req.headers.origin;
  let allowOrigin = CORS_ORIGIN;

  if (CORS_ORIGIN === "*") {
    allowOrigin =
      CORS_ALLOW_CREDENTIALS && requestOrigin ? requestOrigin : "*";
  } else if (requestOrigin) {
    const allowList = CORS_ORIGIN.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowList.length > 0) {
      allowOrigin = allowList.includes(requestOrigin)
        ? requestOrigin
        : allowList[0];
    }
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  if (allowOrigin !== "*" && requestOrigin) {
    res.setHeader("Vary", "Origin");
  }
  if (CORS_ALLOW_CREDENTIALS) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders || "Content-Type, Authorization"
  );

  const requestedMethod = req.headers["access-control-request-method"];
  res.setHeader(
    "Access-Control-Allow-Methods",
    requestedMethod
      ? `${requestedMethod},OPTIONS`
      : "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function startServer() {
  await connectMongo();
  await ensureAdminSeed();
  await syncTelegramWebhook();
  startTelegramPolling();

  const router = createRouter();
  registerRoutes(router);

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(req, res);

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
