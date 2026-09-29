const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const {
  getUserWallet,
  createRecharge,
  markRechargePaid,
  getSettings,
  saveSettings,
  listAdminWallet,
  setUserCharges,
  reviewRecharge,
} = require("../services/wallet.service");

function fail(err) {
  const status = err.statusCode || 400;
  throw createHttpError(status, err.message || "Wallet request failed");
}

async function getWallet(req, res) {
  const userId = req.user?.sub;
  if (!userId) throw createHttpError(401, "Unauthorized");
  const wallet = await getUserWallet(userId);
  sendJson(res, 200, { ok: true, ...wallet });
}

async function recharge(req, res) {
  const userId = req.user?.sub;
  if (!userId) throw createHttpError(401, "Unauthorized");
  const body = await parseBody(req);
  try {
    const payment = await createRecharge(userId, body.rupees ?? body.amount);
    sendJson(res, 200, { ok: true, ...payment });
  } catch (err) {
    fail(err);
  }
}

async function paid(req, res) {
  const userId = req.user?.sub;
  if (!userId) throw createHttpError(401, "Unauthorized");
  const body = await parseBody(req);
  try {
    const transaction = await markRechargePaid(userId, body.id || body.transactionId, body.utr);
    sendJson(res, 200, { ok: true, transaction });
  } catch (err) {
    fail(err);
  }
}

async function adminGet(req, res) {
  const data = await listAdminWallet();
  sendJson(res, 200, { ok: true, ...data });
}

async function adminSaveSettings(req, res) {
  const body = await parseBody(req);
  try {
    const settings = await saveSettings({
      upiId: body.upiId,
      payeeName: body.payeeName,
      creditsPerRupee: body.creditsPerRupee,
      charges: body.charges || {
        alert: body.alert,
        marketMaya: body.marketMaya,
        sharekhan: body.sharekhan,
      },
    });
    sendJson(res, 200, { ok: true, settings });
  } catch (err) {
    fail(err);
  }
}

async function adminSetCharges(req, res) {
  const body = await parseBody(req);
  try {
    const charges = await setUserCharges(body.userId, body.charges || body.chargeOverrides || body);
    sendJson(res, 200, { ok: true, charges });
  } catch (err) {
    fail(err);
  }
}

async function adminReview(req, res) {
  const body = await parseBody(req);
  try {
    const result = await reviewRecharge(body.id || body.transactionId, Boolean(body.approve));
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(err);
  }
}

module.exports = {
  getWallet,
  recharge,
  paid,
  adminGet,
  adminSaveSettings,
  adminSetCharges,
  adminReview,
  getSettings,
};
