const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { processTelegramUpdate } = require("../services/telegramUpdate.service");

async function webhook(req, res) {
  const update = await parseBody(req);
  await processTelegramUpdate(update);
  sendJson(res, 200, { ok: true });
}

module.exports = { webhook };
