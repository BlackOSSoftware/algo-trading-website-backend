const { sendJson } = require("../utils/response");

function notFound(req, res) {
  sendJson(res, 404, { ok: false, error: "Not Found" });
}

module.exports = { notFound };
