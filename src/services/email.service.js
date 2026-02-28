const nodemailer = require("nodemailer");

let cachedTransport = null;

function buildTransport() {
  const host = (process.env.SMTP_HOST || "").trim();
  const portRaw = process.env.SMTP_PORT;
  const user = (process.env.SMTP_USER || "").trim();
  const pass = (process.env.SMTP_PASS || "").trim();

  const port = Number(portRaw || 0);
  if (!host || !user || !pass || !Number.isFinite(port) || port <= 0) {
    throw new Error("SMTP config is missing");
  }

  const secure = port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function getTransport() {
  if (!cachedTransport) {
    cachedTransport = buildTransport();
  }
  return cachedTransport;
}

function getFromAddress() {
  return (process.env.SMTP_FROM || "").trim() || (process.env.SMTP_USER || "").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderLayout({ title, preheader, bodyHtml }) {
  const safeTitle = escapeHtml(title);
  const safePreheader = escapeHtml(preheader || "");
  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${safeTitle}</title>
      <style>
        body { margin:0; padding:0; background:#f6f4ef; font-family: "Segoe UI", Arial, sans-serif; color:#14161d; }
        .wrap { max-width:640px; margin:0 auto; padding:24px; }
        .card { background:#ffffff; border-radius:16px; padding:24px; border:1px solid #ece3d6; }
        h1 { font-size:20px; margin:0 0 12px; }
        .muted { color:#5a6676; font-size:14px; }
        .line { height:1px; background:#ece3d6; margin:16px 0; }
        .pill { display:inline-block; background:#f0f7f8; color:#155a66; padding:6px 12px; border-radius:999px; font-weight:600; font-size:12px; }
        .footer { margin-top:18px; font-size:12px; color:#7b8796; }
      </style>
    </head>
    <body>
      <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${safePreheader}</span>
      <div class="wrap">
        <div class="card">
          ${bodyHtml}
        </div>
        <div class="footer">Market Maya Alerts</div>
      </div>
    </body>
  </html>
  `;
}

function renderLoginEmail({ name, time }) {
  const safeName = escapeHtml(name || "Trader");
  const safeTime = escapeHtml(time || "");
  return renderLayout({
    title: "Login alert",
    preheader: "New login detected",
    bodyHtml: `
      <h1>Login alert</h1>
      <p>Hi ${safeName},</p>
      <p class="muted">We noticed a new login to your account.</p>
      <div class="line"></div>
      <p><strong>Time:</strong> ${safeTime}</p>
      <p class="muted">If this was you, no action is required.</p>
    `,
  });
}

function renderSignalEmail({
  name,
  strategyName,
  alertName,
  scanName,
  stocks,
  receivedAt,
}) {
  const safeName = escapeHtml(name || "Trader");
  const safeStrategy = escapeHtml(strategyName || "Strategy");
  const safeAlert = escapeHtml(alertName || "Signal");
  const safeScan = escapeHtml(scanName || "Chartink");
  const safeStocks = escapeHtml(stocks || "-");
  const safeTime = escapeHtml(receivedAt || "");

  return renderLayout({
    title: "New trading signal",
    preheader: `${safeAlert} · ${safeStrategy}`,
    bodyHtml: `
      <h1>New signal received</h1>
      <p>Hi ${safeName},</p>
      <p class="muted">A new signal arrived for your strategy.</p>
      <div class="line"></div>
      <p><strong>Strategy:</strong> ${safeStrategy}</p>
      <p><strong>Alert:</strong> ${safeAlert}</p>
      <p><strong>Scan:</strong> ${safeScan}</p>
      <p><strong>Stocks:</strong> ${safeStocks}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
    `,
  });
}

function renderBroadcastEmail({ subject, message }) {
  const safeSubject = escapeHtml(subject || "Announcement");
  const safeMessage = escapeHtml(message || "").replace(/\n/g, "<br/>");
  return renderLayout({
    title: safeSubject,
    preheader: safeSubject,
    bodyHtml: `
      <h1>${safeSubject}</h1>
      <p>${safeMessage}</p>
    `,
  });
}

function renderOtpEmail({ name, otp }) {
  const safeName = escapeHtml(name || "Trader");
  const safeOtp = escapeHtml(otp || "");
  return renderLayout({
    title: "Verify your email",
    preheader: `Your OTP is ${safeOtp}`,
    bodyHtml: `
      <h1>Verify your email</h1>
      <p>Hi ${safeName},</p>
      <p class="muted">Use this OTP to verify your email and complete login.</p>
      <div class="line"></div>
      <p class="pill">OTP: ${safeOtp}</p>
      <p class="muted">This OTP expires in 10 minutes.</p>
    `,
  });
}

async function sendEmail({ to, subject, html, text }) {
  if (!to) {
    throw new Error("Recipient is required");
  }
  const from = getFromAddress();
  if (!from) {
    throw new Error("SMTP_FROM is not configured");
  }
  const transport = getTransport();
  return transport.sendMail({ from, to, subject, html, text });
}

async function sendLoginEmail({ to, name }) {
  const time = new Date().toLocaleString();
  const html = renderLoginEmail({ name, time });
  const text = `Login alert\nTime: ${time}`;
  return sendEmail({ to, subject: "Login alert", html, text });
}

async function sendSignalEmail({
  to,
  name,
  strategyName,
  alertName,
  scanName,
  stocks,
  receivedAt,
}) {
  const html = renderSignalEmail({
    name,
    strategyName,
    alertName,
    scanName,
    stocks,
    receivedAt,
  });
  const text = `New signal: ${alertName}\nStrategy: ${strategyName}\nScan: ${scanName}\nStocks: ${stocks}\nTime: ${receivedAt}`;
  return sendEmail({ to, subject: "New trading signal", html, text });
}

async function sendBroadcastEmail({ to, subject, message }) {
  const html = renderBroadcastEmail({ subject, message });
  const text = `${subject}\n\n${message}`;
  return sendEmail({ to, subject, html, text });
}

async function sendOtpEmail({ to, name, otp }) {
  const html = renderOtpEmail({ name, otp });
  const text = `Your OTP is ${otp}. It expires in 10 minutes.`;
  return sendEmail({ to, subject: "Verify your email", html, text });
}

module.exports = {
  sendLoginEmail,
  sendSignalEmail,
  sendBroadcastEmail,
  sendOtpEmail,
};
