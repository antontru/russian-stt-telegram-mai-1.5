import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads required/optional configuration from environment (Azure Function App
 * Settings at runtime, or local.settings.json when running locally).
 */
export function getConfig() {
  const botToken = required('TELEGRAM_BOT_TOKEN');
  const elevenLabsApiKey = required('ELEVENLABS_API_KEY');

  return {
    botToken,
    elevenLabsApiKey,
    // Optional shared secret that Telegram echoes back in a header so we can
    // verify the request really came from Telegram. Set the same value when
    // registering the webhook.
    webhookSecret: process.env.TELEGRAM_SECRET_TOKEN || '',
    // Only this Telegram user is allowed to use the bot. Everyone else is
    // silently ignored. Stored as a numeric string.
    allowedUserId: process.env.ALLOWED_USER_ID || '',
    // Optional ISO 639-1/639-3 language hint (e.g. "rus", "eng"). Leave empty
    // to let Scribe auto-detect, which is best for mixed Russian/English.
    languageCode: process.env.LANGUAGE_CODE || '',
    model: process.env.ELEVENLABS_MODEL || 'scribe_v2',
    // Controls the ElevenLabs `enable_logging` query param. Set the app setting
    // to "false" to request Zero Retention Mode (Enterprise/ZRM accounts only).
    // Set to "true" or leave unset to use the account default. Only "true"/
    // "false" are forwarded; anything else is ignored.
    enableLogging: ['true', 'false'].includes(process.env.ELEVENLABS_ENABLE_LOGGING)
      ? process.env.ELEVENLABS_ENABLE_LOGGING
      : undefined,
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required app setting: ${name}`);
  }
  return value;
}

let cachedKeyterms;

/**
 * Loads the static keyterm list from keyterms.json at the repo root.
 * Cached after first read. Returns at most 1000 terms.
 */
export function getKeyterms() {
  if (cachedKeyterms) return cachedKeyterms;

  try {
    const path = fileURLToPath(new URL('../keyterms.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const terms = Array.isArray(parsed.keyterms) ? parsed.keyterms : [];
    cachedKeyterms = terms
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim())
      .slice(0, 1000);
  } catch {
    cachedKeyterms = [];
  }
  return cachedKeyterms;
}
