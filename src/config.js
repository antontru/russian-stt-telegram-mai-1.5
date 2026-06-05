import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads required/optional configuration from environment (Azure Function App
 * Settings at runtime, or local.settings.json when running locally).
 */
export function getConfig() {
  const botToken = required('TELEGRAM_BOT_TOKEN');
  const speechKey = required('AZURE_SPEECH_KEY');
  const speechEndpoint = resolveSpeechEndpoint();

  return {
    botToken,
    speechKey,
    // Base origin for the Speech resource, e.g.
    // "https://myresource.cognitiveservices.azure.com" or the regional
    // "https://westeurope.api.cognitive.microsoft.com". No trailing slash.
    speechEndpoint,
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

/**
 * Resolves the Speech resource base origin (no trailing slash) from app
 * settings, accepting whatever form the Azure portal hands you:
 *   - AZURE_SPEECH_ENDPOINT — a full endpoint URL, e.g.
 *     "https://westeurope.api.cognitive.microsoft.com/" (the portal's
 *     "Keys and Endpoint" → Endpoint field), or
 *   - AZURE_SPEECH_RESOURCE — a bare resource name ("myresource") which maps
 *     to "https://myresource.cognitiveservices.azure.com", or a full host.
 */
function resolveSpeechEndpoint() {
  const endpoint = process.env.AZURE_SPEECH_ENDPOINT;
  if (endpoint) {
    return stripTrailingSlash(endpoint.trim());
  }
  const resource = process.env.AZURE_SPEECH_RESOURCE;
  if (resource) {
    const value = resource.trim();
    if (/^https?:\/\//i.test(value)) return stripTrailingSlash(value);
    // A dotted value is treated as a hostname; a bare token as a resource name.
    const host = value.includes('.') ? value : `${value}.cognitiveservices.azure.com`;
    return `https://${stripTrailingSlash(host)}`;
  }
  throw new Error('Missing required app setting: AZURE_SPEECH_ENDPOINT or AZURE_SPEECH_RESOURCE');
}

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, '');
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
