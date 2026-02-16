const { registerV1Routes } = require("./v1");
const { health } = require("../controllers/health.controller");

function registerRoutes(router) {
  router.get("/health", health);
  registerV1Routes(router);
}

module.exports = { registerRoutes };
