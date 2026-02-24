const { createRouter } = require("./src/utils/router");
const { registerRoutes } = require("./src/routes");

const router = createRouter();
registerRoutes(router);

console.log(router);
