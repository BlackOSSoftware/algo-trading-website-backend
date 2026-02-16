const { sendJson } = require("../utils/response");

function errorHandler(err, req, res) {
  if (err) {
    console.error("API error:", err);
  }

  if (err && err.code === 11000) {
    sendJson(res, 409, { ok: false, error: "Duplicate entry" });
    return;
  }

  const status = err.status || 500;
  const message =
    status === 500
      ? err.message || "Internal Server Error"
      : err.message;

  sendJson(res, status, { ok: false, error: message });
}

module.exports = { errorHandler };
