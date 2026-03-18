const crypto = require("crypto");
const { getDb } = require("../config/db");
const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { sendBroadcastEmail } = require("../services/email.service");

function normalizeString(value) {
  return String(value || "").trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeString(value).toLowerCase());
}

function resolveSupportEmail() {
  return (
    normalizeString(process.env.CONTACT_EMAIL) ||
    normalizeString(process.env.SUPPORT_EMAIL) ||
    normalizeString(process.env.SMTP_FROM) ||
    normalizeString(process.env.SMTP_USER)
  );
}

async function submitContactRequest(req, res) {
  if (req.method !== "POST") {
    throw createHttpError(405, "Method Not Allowed");
  }

  const body = await parseBody(req);
  const name = normalizeString(body.name);
  const email = normalizeString(body.email).toLowerCase();
  const message = normalizeString(body.message);
  const source = normalizeString(body.source) || "website";

  if (!name || !email || !message) {
    throw createHttpError(400, "name, email, and message are required");
  }
  if (!isValidEmail(email)) {
    throw createHttpError(400, "A valid email is required");
  }
  if (message.length < 10) {
    throw createHttpError(400, "Message should be at least 10 characters");
  }

  const payload = {
    id: crypto.randomUUID(),
    name,
    email,
    message,
    source,
    status: "new",
    createdAt: new Date().toISOString(),
  };

  await getDb().collection("contact_requests").insertOne(payload);

  const supportEmail = resolveSupportEmail();
  let emailed = false;
  let emailError = "";

  if (supportEmail) {
    try {
      await sendBroadcastEmail({
        to: supportEmail,
        subject: `New website inquiry from ${name}`,
        message: `Name: ${name}\nEmail: ${email}\nSource: ${source}\n\nMessage:\n${message}`,
      });
      emailed = true;
    } catch (error) {
      emailError = error instanceof Error ? error.message : "Unable to send support email";
    }
  }

  sendJson(res, 200, {
    ok: true,
    submitted: true,
    emailed,
    ...(emailError ? { emailError } : {}),
  });
}

module.exports = { submitContactRequest };
