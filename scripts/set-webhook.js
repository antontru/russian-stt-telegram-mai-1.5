/**
 * One-off helper to register (or clear) the Telegram webhook.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET_TOKEN=... \
 *   FUNCTION_URL=https://<app>.azurewebsites.net/api/telegram \
 *   node scripts/set-webhook.js
 *
 *   # to remove the webhook:
 *   TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.js --delete
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const api = `https://api.telegram.org/bot${token}`;

if (process.argv.includes('--delete')) {
  const res = await fetch(`${api}/deleteWebhook`, { method: 'POST' });
  console.log(await res.json());
  process.exit(0);
}

const url = process.env.FUNCTION_URL;
if (!url) {
  console.error('FUNCTION_URL is required (e.g. https://<app>.azurewebsites.net/api/telegram)');
  process.exit(1);
}

const body = {
  url,
  // Only deliver the message types we handle.
  allowed_updates: ['message', 'edited_message'],
  // Drop any updates that piled up while the webhook was unset.
  drop_pending_updates: true,
};
if (process.env.TELEGRAM_SECRET_TOKEN) {
  body.secret_token = process.env.TELEGRAM_SECRET_TOKEN;
}

const res = await fetch(`${api}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(await res.json());
