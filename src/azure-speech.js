// Azure AI Speech "fast transcription" (synchronous) REST API.
// Uses the MAI-Transcribe model family, which is the only one that supports
// phrase lists (keyterm biasing) and transcribe styles.
// https://learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe

const API_VERSION = '2025-10-15';

// Azure's phrase list caps the number of phrases; stay comfortably under it.
const MAX_PHRASES = 200;

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
 * @param {string} [opts.languageCode] Optional BCP-47 locale (e.g. "ru-RU").
 *   Omit to let the service auto-detect (best for mixed Russian/English).
 * @param {string[]} [opts.keyterms]   Phrases to bias recognition toward
 *   (MAI-Transcribe phrase list). Only honored by MAI-Transcribe models.
 * @param {string} [opts.transcribeStyle] Optional MAI-Transcribe style, e.g.
 *   "verbatim". Omit for the default cleaned/formatted output (drops fillers
 *   and disfluencies).
 * @returns {Promise<{text: string, languageCode?: string}>}
 */
export async function transcribe({ apiKey, endpoint, bytes, filename, contentType, model, languageCode, keyterms, transcribeStyle }) {
  const definition = {
    // enhancedMode selects the MAI-Transcribe model.
    enhancedMode: { enabled: true, model },
  };
  if (transcribeStyle) {
    // e.g. "verbatim" to keep fillers/disfluencies. Omitting it yields the
    // default cleaned transcript.
    definition.enhancedMode.transcribeStyle = transcribeStyle;
  }
  if (languageCode) {
    // Force a single locale. Without this the service auto-detects.
    definition.locales = [languageCode];
  }
  const phrases = (keyterms || []).slice(0, MAX_PHRASES);
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
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Azure Speech STT failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  // combinedPhrases holds the full transcript (one entry per speaker channel).
  const text = (data.combinedPhrases || []).map((p) => p.text).join(' ').trim();
  // Per-phrase locale is only present when the service auto-detected a language.
  const detectedLocale = data.phrases?.[0]?.locale;
  return { text, languageCode: detectedLocale };
}
