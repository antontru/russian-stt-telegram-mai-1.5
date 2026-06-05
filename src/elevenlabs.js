const STT_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Transcribes an audio/video buffer with ElevenLabs Scribe.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Buffer} opts.bytes        Raw media bytes.
 * @param {string} opts.filename     Filename hint (helps format detection).
 * @param {string} opts.contentType  MIME type of the media.
 * @param {string} opts.model        Model id, e.g. "scribe_v2".
 * @param {string} [opts.languageCode] Optional ISO 639 language hint.
 * @param {string[]} [opts.keyterms]   Terms to bias recognition toward.
 * @returns {Promise<{text: string, languageCode?: string}>}
 */
export async function transcribe({ apiKey, bytes, filename, contentType, model, languageCode, keyterms }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  form.append('model_id', model);
  if (languageCode) {
    form.append('language_code', languageCode);
  }
  // ElevenLabs accepts keyterms as repeated multipart fields.
  for (const term of keyterms || []) {
    form.append('keyterms', term);
  }

  const res = await fetch(STT_ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs STT failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  return { text: data.text ?? '', languageCode: data.language_code };
}
