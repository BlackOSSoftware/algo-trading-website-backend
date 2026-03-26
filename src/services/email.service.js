const nodemailer = require("nodemailer");

let cachedTransport = null;

const BRAND_NAME = "Emotionless Traders";
const BRAND_TAGLINE = "Trade with discipline, not impulse.";
const SUPPORT_LABEL = `${BRAND_NAME} Team`;

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

function normalizeBrandText(value) {
  return String(value || "").replace(/market\s*maya/gi, BRAND_NAME);
}

function renderInfoRows(items) {
  const rows = (items || [])
    .filter((item) => item && item.value)
    .map(
      (item) => `
        <div class="info-row">
          <span class="info-label">${escapeHtml(item.label)}</span>
          <strong class="info-value">${escapeHtml(item.value)}</strong>
        </div>
      `
    )
    .join("");

  if (!rows) return "";
  return `<div class="info-grid">${rows}</div>`;
}

function renderMessageBlocks(message) {
  const source = String(message || "").trim();
  if (!source) return "";
  return source
    .split(/\n\s*\n/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`)
    .join("");
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
        body { margin:0; padding:0; background:#f4efe6; font-family:"Segoe UI", Arial, sans-serif; color:#172033; }
        .wrap { max-width:680px; margin:0 auto; padding:32px 18px; }
        .shell { background:#ffffff; border:1px solid #e9decf; border-radius:24px; overflow:hidden; box-shadow:0 16px 40px rgba(23,32,51,0.08); }
        .hero { padding:28px 28px 22px; background:linear-gradient(135deg, #10233d 0%, #1d4d61 100%); color:#ffffff; }
        .brand-chip { display:inline-block; padding:6px 12px; border-radius:999px; background:rgba(255,255,255,0.14); font-size:12px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; }
        .brand-title { margin:16px 0 6px; font-size:26px; line-height:1.2; font-weight:700; }
        .brand-subtitle { margin:0; font-size:14px; line-height:1.6; color:rgba(255,255,255,0.84); }
        .content { padding:28px; }
        h1 { font-size:24px; line-height:1.25; margin:0 0 12px; color:#172033; }
        p { margin:0 0 14px; font-size:15px; line-height:1.7; color:#354056; }
        .muted { color:#66748b; font-size:14px; }
        .section { margin-top:22px; padding:18px; border-radius:18px; background:#fbf8f3; border:1px solid #eee3d4; }
        .section-title { margin:0 0 12px; font-size:13px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#7b6648; }
        .info-grid { display:grid; gap:10px; }
        .info-row { display:flex; justify-content:space-between; gap:16px; padding:10px 0; border-bottom:1px solid #eadfce; }
        .info-row:last-child { border-bottom:none; padding-bottom:0; }
        .info-label { color:#6a7488; font-size:13px; }
        .info-value { color:#172033; font-size:14px; text-align:right; }
        .otp-box { margin:18px 0 14px; padding:18px 20px; border-radius:18px; background:#10233d; color:#ffffff; text-align:center; font-size:28px; font-weight:700; letter-spacing:0.28em; }
        .note { margin-top:18px; padding:14px 16px; border-radius:16px; background:#eef6f2; border:1px solid #d9e8df; color:#355246; font-size:13px; line-height:1.6; }
        .footer { padding:0 28px 26px; }
        .footer-card { border-top:1px solid #ebe2d6; padding-top:18px; }
        .footer-title { font-size:13px; font-weight:700; color:#172033; margin-bottom:6px; }
        .footer-copy { font-size:12px; line-height:1.6; color:#7b8698; }
      </style>
    </head>
    <body>
      <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${safePreheader}</span>
      <div class="wrap">
        <div class="shell">
          <div class="hero">
            <div class="brand-chip">${BRAND_NAME}</div>
            <div class="brand-title">${safeTitle}</div>
            <p class="brand-subtitle">${BRAND_TAGLINE}</p>
          </div>
          <div class="content">
            ${bodyHtml}
          </div>
          <div class="footer">
            <div class="footer-card">
              <div class="footer-title">${SUPPORT_LABEL}</div>
              <div class="footer-copy">
                This is an automated email from ${BRAND_NAME}. Please keep this message for your records.
              </div>
            </div>
          </div>
        </div>
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
      <p class="muted">We noticed a fresh login on your account.</p>
      <div class="section">
        <div class="section-title">Activity details</div>
        ${renderInfoRows([{ label: "Time", value: safeTime }])}
      </div>
      <div class="note">If this was you, no action is required. If not, please review account access immediately.</div>
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
    preheader: `${safeAlert} - ${safeStrategy}`,
    bodyHtml: `
      <h1>New signal received</h1>
      <p>Hi ${safeName},</p>
      <p class="muted">A new signal has been received for your saved strategy.</p>
      <div class="section">
        <div class="section-title">Signal summary</div>
        ${renderInfoRows([
          { label: "Strategy", value: safeStrategy },
          { label: "Alert", value: safeAlert },
          { label: "Scan", value: safeScan },
          { label: "Stocks", value: safeStocks },
          { label: "Time", value: safeTime },
        ])}
      </div>
    `,
  });
}

function renderBroadcastEmail({ subject, message }) {
  const safeSubject = escapeHtml(subject || "Announcement");

  return renderLayout({
    title: safeSubject,
    preheader: safeSubject,
    bodyHtml: `
      <h1>${safeSubject}</h1>
      <p class="muted">A new update has been shared with you.</p>
      <div class="section">
        <div class="section-title">Message</div>
        ${renderMessageBlocks(message)}
      </div>
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
      <div class="otp-box">${safeOtp}</div>
      <div class="note">This OTP expires in 10 minutes. Do not share it with anyone.</div>
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
  return transport.sendMail({
    from,
    to,
    subject: normalizeBrandText(subject),
    html: normalizeBrandText(html),
    text: normalizeBrandText(text),
  });
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
