// Azure AI Speech "fast transcription" (synchronous) REST API.
// Uses the MAI-Transcribe model family, which is the only one that supports
// phrase lists (keyterm biasing) and transcribe styles.
// https://learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe
//
// Note: MAI-Transcribe is still in public preview (no SLA). It does not support
// diarization, channel separation, translation, or prompt-tuning — those need
// the non-MAI LLM Speech enhanced model.

// Still the current version: the REST reference's version selector only offers
// older ones (2024-11-15, 2024-05-15-preview).
const API_VERSION = '2025-10-15';

// MAI-Transcribe's phrase list ("context list") cap. We first hit HTTP 400
// "Context list cannot have more than 50 items." against mai-transcribe-1;
// Microsoft's Foundry notebook for mai-transcribe-1.5 now documents up to 200.
// Run `npm run probe-phrase-limit` against your own resource to find the real
// ceiling, then raise it with AZURE_PHRASE_LIST_MAX.
export const DEFAULT_MAX_PHRASES = 50;

// The whole request must finish inside the Functions HTTP timeout (230s on
// Consumption), and the cleanup pass still has to run after it.
const REQUEST_TIMEOUT_MS = 150_000;

/**
 * Transcribes an audio/video buffer with the Azure Speech fast transcription
 * API using a MAI-Transcribe model.
 *
 * The synchronous fast-transcription endpoint processes audio in-flight and
 * returns the transcript in a single response. Unlike batch transcription it
 * does not persist the audio or transcript to storage, so it is effectively
 * zero-retention by default (no logging flag required).
 *
 * @param {object} opts
 * @param {string} opts.apiKey        Speech resource key (Ocp-Apim-Subscription-Key).
 * @param {string} opts.endpoint      Speech resource base origin, e.g.
 *   "https://myresource.cognitiveservices.azure.com" or the regional
 *   "https://westeurope.api.cognitive.microsoft.com" (no trailing slash).
 * @param {Buffer} opts.bytes         Raw media bytes.
 * @param {string} opts.filename      Filename hint (sent as the multipart filename).
 * @param {string} opts.contentType   MIME type of the media.
 * @param {string} opts.model         Model id, e.g. "mai-transcribe-1.5".
 * @param {string} [opts.languageCode] Optional locale to force a single language.
 *   MAI-Transcribe's docs use bare codes ("ru", "en"); BCP-47 ("ru-RU") is also
 *   accepted. Omit to let the service auto-detect — best for mixed RU/EN.
 * @param {string[]} [opts.keyterms]   Phrases to bias recognition toward
 *   (MAI-Transcribe phrase list). Only honored by MAI-Transcribe models.
 * @param {number} [opts.maxPhrases]   Phrase list cap. Defaults to 50.
 * @param {string} [opts.transcribeStyle] Optional MAI-Transcribe style. Omit for
 *   the default readability-optimized transcript (drops fillers and
 *   disfluencies); "verbatim" keeps them. Only "verbatim" is documented as an
 *   explicit value — "readability" is the documented *default*, not a
 *   documented input, so we omit rather than send it.
 * @returns {Promise<{text: string, languageCode?: string, durationMs?: number, confidence?: number, phraseCount: number}>}
 */
export async function transcribe({
  apiKey, endpoint, bytes, filename, contentType, model,
  languageCode, keyterms, maxPhrases = DEFAULT_MAX_PHRASES, transcribeStyle,
}) {
  const definition = {
    // enhancedMode selects the MAI-Transcribe model.
    enhancedMode: { enabled: true, model },
  };
  if (transcribeStyle) {
    definition.enhancedMode.transcribeStyle = transcribeStyle;
  }
  if (languageCode) {
    // Force a single locale. Without this the service auto-detects.
    definition.locales = [languageCode];
  }
  const phrases = (keyterms || []).slice(0, maxPhrases);
  if (phrases.length > 0) {
    definition.phraseList = { phrases };
  }

  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: contentType }), filename);
  form.append('definition', JSON.stringify(definition));

  const url =
    `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Azure Speech STT failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  // combinedPhrases holds the full transcript (one entry per speaker channel).
  const text = (data.combinedPhrases || []).map((p) => p.text).join(' ').trim();
  const segments = data.phrases || [];
  // Per-phrase locale is only present when the service auto-detected a language.
  const detectedLocale = segments[0]?.locale;
  return {
    text,
    languageCode: detectedLocale,
    durationMs: data.durationMilliseconds,
    confidence: meanConfidence(segments),
    phraseCount: phrases.length,
  };
}

/** Mean per-segment confidence, useful for spotting a bad recording in logs. */
function meanConfidence(segments) {
  const values = segments.map((p) => p.confidence).filter((c) => typeof c === 'number');
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
