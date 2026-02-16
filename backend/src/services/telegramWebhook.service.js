function resolveWebhookUrl() {
  const explicit = (process.env.TELEGRAM_WEBHOOK_URL || "").trim();
  if (explicit) return explicit;

  const baseUrl =
    (process.env.PUBLIC_BASE_URL || "").trim() ||
    (process.env.APP_URL || "").trim() ||
    (process.env.BASE_URL || "").trim();
  if (!baseUrl) return "";

  return `${baseUrl.replace(/\/$/, "")}/api/v1/telegram/webhook`;
}

function isLocalUrl(url) {
  return /localhost|127\.0\.0\.1/i.test(url);
}

async function syncTelegramWebhook() {
  if (process.env.TELEGRAM_POLLING === "true") {
    return { ok: false, skipped: "polling_enabled" };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, skipped: "no_token" };

  const url = resolveWebhookUrl();
  if (!url) return { ok: false, skipped: "no_url" };
  if (isLocalUrl(url)) {
    return { ok: false, skipped: "local_url" };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, drop_pending_updates: true }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: data.description || "Failed to set webhook" };
  }

  return { ok: true, url };
}

module.exports = { resolveWebhookUrl, syncTelegramWebhook };
