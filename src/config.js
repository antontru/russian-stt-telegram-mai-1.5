import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads required/optional configuration from environment (Azure Function App
 * Settings at runtime, or local.settings.json when running locally).
 */
export function getConfig() {
  const botToken = required('TELEGRAM_BOT_TOKEN');
  const speechKey = required('AZURE_SPEECH_KEY');
  const speechResource = required('AZURE_SPEECH_RESOURCE');

  return {
    botToken,
    speechKey,
    // Azure Speech resource name — the "{name}" in
    // {name}.cognitiveservices.azure.com. Region is implied by the resource.
    speechResource,
    // Optional shared secret that Telegram echoes back in a header so we can
    // verify the request really came from Telegram. Set the same value when
    // registering the webhook.
    webhookSecret: process.env.TELEGRAM_SECRET_TOKEN || '',
    // Only this Telegram user is allowed to use the bot. Everyone else is
    // silently ignored. Stored as a numeric string.
    allowedUserId: process.env.ALLOWED_USER_ID || '',
    // Optional BCP-47 locale hint (e.g. "ru-RU", "en-US"). Leave empty to let
    // the service auto-detect, which is best for mixed Russian/English.
    languageCode: process.env.LANGUAGE_CODE || '',
    model: process.env.AZURE_SPEECH_MODEL || 'mai-transcribe-1.5',
    // Optional MAI-Transcribe style. Set to "verbatim" to keep fillers and
    // disfluencies. Leave unset for the default cleaned/formatted transcript.
    transcribeStyle: process.env.AZURE_TRANSCRIBE_STYLE || '',
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
