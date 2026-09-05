import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_PHRASES } from './azure-speech.js';

// "clean" (readability, the default here) or "verbatim" (keep fillers). The
// wire format differs per model — azure-speech.js translates the intent.
const VALID_TRANSCRIBE_STYLES = new Set(['verbatim', 'clean']);

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
    // Optional locale hint. MAI-Transcribe's docs use bare codes ("ru", "en");
    // BCP-47 ("ru-RU") also works. Leave empty to let the service auto-detect,
    // which is best for mixed Russian/English.
    languageCode: process.env.LANGUAGE_CODE || '',
    // MAI-Transcribe-2 (released 2026-09-03): more accurate, faster, and
    // cheaper ($0.10/audio-hour promo through 2026-12-31). Set
    // AZURE_SPEECH_MODEL=mai-transcribe-1.5 to fall back — 1.5 is still live
    // and takes a 200-item phrase list where 2 caps at 50. mai-transcribe-1
    // was deprecated on 2026-08-20.
    model: process.env.AZURE_SPEECH_MODEL || 'MAI-Transcribe-2',
    // Optional MAI-Transcribe style. Set to "verbatim" to keep fillers and
    // disfluencies. Leave unset (or "clean") for the readability-optimized
    // transcript. An unrecognized value is dropped rather than sent, so a typo
    // or a stale setting can't silently degrade every transcript.
    transcribeStyle: normalizeTranscribeStyle(process.env.AZURE_TRANSCRIBE_STYLE),
    // Phrase list cap. See DEFAULT_MAX_PHRASES / npm run probe-phrase-limit.
    phraseListMax: positiveInt(process.env.AZURE_PHRASE_LIST_MAX, DEFAULT_MAX_PHRASES),
    // Diagnostic: log the raw pre-cleanup transcript so a bad word can be
    // attributed to the recognizer vs. the cleanup model. Off by default —
    // it writes transcript text into Application Insights, which is the one
    // place this otherwise zero-retention pipeline would persist your speech.
    logRawTranscript: /^(1|true|yes)$/i.test(process.env.LOG_RAW_TRANSCRIPT || ''),
    // Optional transcript post-processing with a chat model on Azure Foundry.
    // Cleanup runs only when both endpoint and key are set.
    cleanup: {
      endpoint: stripTrailingSlash((process.env.AZURE_FOUNDRY_ENDPOINT || '').trim()),
      apiKey: process.env.AZURE_FOUNDRY_KEY || '',
      model: process.env.AZURE_FOUNDRY_MODEL || 'Phi-4',
    },
  };
}

/** Returns the style only if the service documents it; otherwise omits it. */
function normalizeTranscribeStyle(value) {
  const style = (value || '').trim().toLowerCase();
  return VALID_TRANSCRIBE_STYLES.has(style) ? style : '';
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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
 * Cached after first read. The list is capped at send time (phraseListMax),
 * so everything in the file is returned here — the tail still feeds the
 * cleanup model's spelling glossary even when it doesn't fit the phrase list.
 */
export function getKeyterms() {
  if (cachedKeyterms) return cachedKeyterms;

  try {
    const path = fileURLToPath(new URL('../keyterms.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const terms = Array.isArray(parsed.keyterms) ? parsed.keyterms : [];
    cachedKeyterms = terms
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
  } catch {
    cachedKeyterms = [];
  }
  return cachedKeyterms;
}
