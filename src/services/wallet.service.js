const { ObjectId } = require("mongodb");
const QRCode = require("qrcode");
const { getDb } = require("../config/db");

const SETTINGS_ID = "default";
const DEFAULT_CHARGES = {
  alert: 1,
  marketMaya: 2,
  sharekhan: 2,
};

function settingsCollection() {
  return getDb().collection("wallet_settings");
}

function txCollection() {
  return getDb().collection("wallet_transactions");
}

function usersCollection() {
  return getDb().collection("users");
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampCharge(value, fallback) {
  const number = Math.round(toNumber(value, fallback));
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, 100000);
}

function unwrap(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, "value")) return result.value;
  return result;
}

function userId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const text = String(value);
  if (!ObjectId.isValid(text)) return null;
  return new ObjectId(text);
}

async function getSettings() {
  const stored = await settingsCollection().findOne({ _id: SETTINGS_ID });
  return {
    upiId: String(stored?.upiId || "").trim(),
    payeeName: String(stored?.payeeName || "Emotionless Traders").trim() || "Emotionless Traders",
    creditsPerRupee: Math.max(1, Math.round(toNumber(stored?.creditsPerRupee, 1))),
    charges: {
      alert: clampCharge(stored?.charges?.alert, DEFAULT_CHARGES.alert),
      marketMaya: clampCharge(stored?.charges?.marketMaya, DEFAULT_CHARGES.marketMaya),
      sharekhan: clampCharge(stored?.charges?.sharekhan, DEFAULT_CHARGES.sharekhan),
    },
  };
}

async function saveSettings(input) {
  const current = await getSettings();
  const upiId = String(input.upiId ?? current.upiId).trim();
  if (upiId && !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiId)) {
    const error = new Error("Enter a valid UPI ID, for example name@okhdfcbank");
    error.statusCode = 400;
    throw error;
  }
  const next = {
    upiId,
    payeeName: String(input.payeeName ?? current.payeeName).trim() || "Emotionless Traders",
    creditsPerRupee: Math.max(1, Math.round(toNumber(input.creditsPerRupee, current.creditsPerRupee))),
    charges: {
      alert: clampCharge(input.charges?.alert, current.charges.alert),
      marketMaya: clampCharge(input.charges?.marketMaya, current.charges.marketMaya),
      sharekhan: clampCharge(input.charges?.sharekhan, current.charges.sharekhan),
    },
    updatedAt: new Date().toISOString(),
  };
  await settingsCollection().updateOne({ _id: SETTINGS_ID }, { $set: next }, { upsert: true });
  return getSettings();
}

async function getBalance(id) {
  const _id = userId(id);
  if (!_id) return 0;
  const user = await usersCollection().findOne({ _id }, { projection: { walletBalance: 1 } });
  return Math.max(0, Math.round(toNumber(user?.walletBalance, 0)));
}

async function resolveCharges(id) {
  const settings = await getSettings();
  const _id = userId(id);
  const user = _id
    ? await usersCollection().findOne({ _id }, { projection: { chargeOverrides: 1 } })
    : null;
  const overrides = user?.chargeOverrides || {};
  const pick = (key) =>
    overrides[key] === undefined || overrides[key] === null || overrides[key] === ""
      ? settings.charges[key]
      : clampCharge(overrides[key], settings.charges[key]);
  return {
    alert: pick("alert"),
    marketMaya: pick("marketMaya"),
    sharekhan: pick("sharekhan"),
    creditsPerRupee: settings.creditsPerRupee,
    defaults: settings.charges,
    overrides: {
      alert: overrides.alert ?? null,
      marketMaya: overrides.marketMaya ?? null,
      sharekhan: overrides.sharekhan ?? null,
    },
  };
}

function publicTx(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    userId: doc.userId ? String(doc.userId) : "",
    userName: doc.userName || "",
    userEmail: doc.userEmail || "",
    kind: doc.kind,
    status: doc.status,
    credits: Number(doc.credits || 0),
    rupees: doc.rupees == null ? null : Number(doc.rupees),
    chargeKey: doc.chargeKey || "",
    title: doc.title || "",
    note: doc.note || "",
    utr: doc.utr || "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt || doc.createdAt,
  };
}

async function insertTx(doc) {
  const now = new Date().toISOString();
  const record = { ...doc, createdAt: now, updatedAt: now };
  const result = await txCollection().insertOne(record);
  return publicTx({ _id: result.insertedId, ...record });
}

async function debit(id, credits, meta) {
  const _id = userId(id);
  const cost = Math.round(toNumber(credits, 0));
  if (!_id || cost <= 0) {
    return { ok: true, charged: 0, balance: await getBalance(id), held: false };
  }
  await usersCollection().updateOne(
    { _id, walletBalance: { $exists: false } },
    { $set: { walletBalance: 0 } }
  );
  const updated = await usersCollection().findOneAndUpdate(
    { _id, walletBalance: { $gte: cost } },
    { $inc: { walletBalance: -cost } },
    { returnDocument: "after", projection: { walletBalance: 1, name: 1, email: 1 } }
  );
  const updatedUser = unwrap(updated);
  if (!updatedUser) {
    const balance = await getBalance(id);
    return {
      ok: false,
      held: false,
      charged: 0,
      balance,
      reason: `Not enough credits. This needs ${cost}, wallet has ${balance}.`,
    };
  }
  const tx = await insertTx({
    userId: _id,
    userName: updatedUser.name || "",
    userEmail: updatedUser.email || "",
    kind: "debit",
    status: "completed",
    credits: -cost,
    rupees: null,
    chargeKey: meta.chargeKey || "",
    title: meta.title || "Charge",
    note: meta.note || "",
    utr: "",
  });
  return {
    ok: true,
    held: true,
    charged: cost,
    balance: Math.round(toNumber(updatedUser.walletBalance, 0)),
    txId: tx.id,
    tx,
  };
}

async function credit(id, credits, meta) {
  const _id = userId(id);
  const amount = Math.round(toNumber(credits, 0));
  if (!_id || amount <= 0) return { ok: false, balance: await getBalance(id) };
  const updated = await usersCollection().findOneAndUpdate(
    { _id },
    { $inc: { walletBalance: amount } },
    { returnDocument: "after", projection: { walletBalance: 1, name: 1, email: 1 } }
  );
  const updatedUser = unwrap(updated);
  if (!updatedUser) return { ok: false, balance: 0 };
  const tx = await insertTx({
    userId: _id,
    userName: updatedUser.name || meta.userName || "",
    userEmail: updatedUser.email || meta.userEmail || "",
    kind: meta.kind || "credit",
    status: "completed",
    credits: amount,
    rupees: meta.rupees == null ? null : Number(meta.rupees),
    chargeKey: meta.chargeKey || "",
    title: meta.title || "Credit",
    note: meta.note || "",
    utr: meta.utr || "",
  });
  return { ok: true, balance: Math.round(toNumber(updatedUser.walletBalance, 0)), tx };
}

async function holdCharge(id, chargeKey, meta = {}) {
  const charges = await resolveCharges(id);
  const cost = charges[chargeKey];
  return debit(id, cost, {
    chargeKey,
    title: meta.title || chargeKey,
    note: meta.note || "",
  });
}

async function releaseHold(id, hold, reason) {
  if (!hold?.held || !hold.charged) return null;
  return credit(id, hold.charged, {
    kind: "refund",
    chargeKey: "refund",
    title: "Refund",
    note: reason || "Charge reversed because the action did not complete",
  });
}

function buildUpiLink({ upiId, payeeName, rupees, note }) {
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    am: Number(rupees).toFixed(2),
    cu: "INR",
    tn: note || "Wallet recharge",
  });
  return `upi://pay?${params.toString()}`;
}

async function createRecharge(id, rupeesInput) {
  const _id = userId(id);
  if (!_id) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
  const rupees = Math.round(toNumber(rupeesInput, 0));
  if (rupees < 1 || rupees > 100000) {
    const error = new Error("Enter a recharge amount between 1 and 100000 rupees");
    error.statusCode = 400;
    throw error;
  }
  const settings = await getSettings();
  if (!settings.upiId) {
    const error = new Error("UPI ID is not set yet. Ask admin to add it.");
    error.statusCode = 400;
    throw error;
  }
  const user = await usersCollection().findOne(
    { _id },
    { projection: { name: 1, email: 1 } }
  );
  const credits = rupees * settings.creditsPerRupee;
  const note = `Wallet ${credits} credits`;
  const upiLink = buildUpiLink({
    upiId: settings.upiId,
    payeeName: settings.payeeName,
    rupees,
    note,
  });
  const qrDataUrl = await QRCode.toDataURL(upiLink, { width: 320, margin: 1 });
  const tx = await insertTx({
    userId: _id,
    userName: user?.name || "",
    userEmail: user?.email || "",
    kind: "recharge",
    status: "pending",
    credits,
    rupees,
    chargeKey: "recharge",
    title: "Recharge",
    note,
    utr: "",
    upiId: settings.upiId,
  });
  return {
    transaction: tx,
    upiId: settings.upiId,
    payeeName: settings.payeeName,
    rupees,
    credits,
    upiLink,
    qrDataUrl,
  };
}

async function markRechargePaid(id, txId, utr) {
  const _id = userId(id);
  if (!_id || !ObjectId.isValid(String(txId || ""))) {
    const error = new Error("Recharge not found");
    error.statusCode = 404;
    throw error;
  }
  const result = await txCollection().findOneAndUpdate(
    { _id: new ObjectId(String(txId)), userId: _id, kind: "recharge", status: "pending" },
    { $set: { status: "paid", utr: String(utr || "").trim(), updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  const saved = unwrap(result);
  if (!saved) {
    const error = new Error("Pending recharge not found");
    error.statusCode = 404;
    throw error;
  }
  return publicTx(saved);
}

async function listUserTransactions(id, limit = 40) {
  const _id = userId(id);
  if (!_id) return [];
  const rows = await txCollection()
    .find({ userId: _id })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .toArray();
  return rows.map(publicTx);
}

async function getUserWallet(id) {
  const settings = await getSettings();
  const charges = await resolveCharges(id);
  return {
    balance: await getBalance(id),
    upiReady: Boolean(settings.upiId),
    payeeName: settings.payeeName,
    creditsPerRupee: settings.creditsPerRupee,
    charges: {
      alert: charges.alert,
      marketMaya: charges.marketMaya,
      sharekhan: charges.sharekhan,
    },
    transactions: await listUserTransactions(id),
  };
}

async function listAdminWallet() {
  const settings = await getSettings();
  const users = await usersCollection()
    .find({ role: { $ne: "admin" } })
    .project({ name: 1, email: 1, walletBalance: 1, chargeOverrides: 1 })
    .sort({ name: 1 })
    .limit(300)
    .toArray();
  const pending = await txCollection()
    .find({ kind: "recharge", status: { $in: ["pending", "paid"] } })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return {
    settings,
    users: users.map((user) => ({
      id: String(user._id),
      name: user.name || "",
      email: user.email || "",
      balance: Math.round(toNumber(user.walletBalance, 0)),
      chargeOverrides: {
        alert: user.chargeOverrides?.alert ?? null,
        marketMaya: user.chargeOverrides?.marketMaya ?? null,
        sharekhan: user.chargeOverrides?.sharekhan ?? null,
      },
    })),
    pending: pending.map(publicTx),
  };
}

async function setUserCharges(id, overrides) {
  const _id = userId(id);
  if (!_id) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }
  const clean = {};
  ["alert", "marketMaya", "sharekhan"].forEach((key) => {
    const raw = overrides?.[key];
    if (raw === "" || raw === null || raw === undefined) return;
    clean[key] = clampCharge(raw, 0);
  });
  await usersCollection().updateOne({ _id }, { $set: { chargeOverrides: clean } });
  return resolveCharges(_id);
}

async function reviewRecharge(txId, approve) {
  if (!ObjectId.isValid(String(txId || ""))) {
    const error = new Error("Recharge not found");
    error.statusCode = 404;
    throw error;
  }
  const existing = await txCollection().findOne({
    _id: new ObjectId(String(txId)),
    kind: "recharge",
    status: { $in: ["pending", "paid"] },
  });
  if (!existing) {
    const error = new Error("Pending recharge not found");
    error.statusCode = 404;
    throw error;
  }
  if (!approve) {
    await txCollection().updateOne(
      { _id: existing._id },
      { $set: { status: "rejected", updatedAt: new Date().toISOString() } }
    );
    return publicTx({ ...existing, status: "rejected" });
  }
  const updated = await usersCollection().findOneAndUpdate(
    { _id: userId(existing.userId) },
    { $inc: { walletBalance: Math.round(toNumber(existing.credits, 0)) } },
    { returnDocument: "after", projection: { walletBalance: 1 } }
  );
  const updatedUser = unwrap(updated);
  await txCollection().updateOne(
    { _id: existing._id },
    { $set: { status: "approved", updatedAt: new Date().toISOString() } }
  );
  return {
    transaction: publicTx({ ...existing, status: "approved" }),
    balance: Math.round(toNumber(updatedUser?.walletBalance, 0)),
  };
}

module.exports = {
  getSettings,
  saveSettings,
  getUserWallet,
  createRecharge,
  markRechargePaid,
  holdCharge,
  releaseHold,
  listAdminWallet,
  setUserCharges,
  reviewRecharge,
};
