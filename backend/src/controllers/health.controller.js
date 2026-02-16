const { sendJson } = require("../utils/response");

function health(req, res) {
  sendJson(res, 200, { status: "ok" });
}

module.exports = { health };
