// Post-processing: clean a raw transcript with a chat model on Azure Foundry
// (Azure OpenAI v1 API).
//
// Two jobs, not one:
//   1. Remove fillers/hesitations/false starts.
//   2. Restore English technical terms that MAI-Transcribe transliterated into
//      Cyrillic ("Азжур" → "Azure", "Тенант" → "tenant"). The phrase list
//      cannot fix these — the model has already recognized the word correctly
//      and then declined it into a Russian case, so there is no Latin-script
//      form it could have emitted. It has to be repaired downstream.
//
// The default model (Phi-4) is small, so the guardrails below matter: long
// transcripts are chunked to stay well inside its context window, and any
// response that looks truncated or summarized is rejected so the caller can
// fall back to the raw transcript.

// Characters per request. Russian runs ~2-3 chars/token, so ~4000 chars is
// ~1500-2000 tokens in and a similar number out — comfortable for Phi-4's
// 16k context even with the glossary attached.
const MAX_CHUNK_CHARS = 4000;

// A cleaned chunk shorter than this fraction of its input means the model
// summarized or truncated instead of cleaning. Filler removal alone rarely
// takes more than ~25% off.
const MIN_LENGTH_RATIO = 0.6;

const REQUEST_TIMEOUT_MS = 60_000;

const RULES = `You are a transcript cleaner for speech-to-text output. You receive text between <transcript> and </transcript> tags.

Apply exactly these three edits and nothing else:

1. Remove filler words, hesitation sounds, false starts, and stuttered repetitions.
   Russian fillers: э-э, а-а, м-м, ну, вот, как бы, типа, значит, короче, это самое.
   English fillers: um, uh, like, you know, I mean, sort of.
2. Product names, company names, and technical nouns that were transliterated into Cyrillic must be rewritten in Latin script in their dictionary base form. Examples: "Азжур"/"Ажур" -> "Azure", "Тенант" -> "tenant", "Шерпоинт" -> "SharePoint", "Дataverse" -> "Dataverse".
   Leave Russian VERBS in Cyrillic even when they derive from English (запровижинить, задеплоить, зашарить) — only fix their spelling. Leave Russian grammar untouched.
3. Repair punctuation and sentence boundaries left broken by the removals. Where a phrase was abandoned mid-thought ("Мне нужно будет список..."), DELETE the abandoned fragment. Do NOT finish it — the speaker never finished it either.

Hard constraints — adding words is worse than leaving the text dirty:
- NEVER add a word the speaker did not say. In particular: no greeting at the start (Привет, Здравствуйте, Hi, Hello), no connector bolted onto the first sentence (И, А, Так, So, Well), no hedges or modality the speaker did not use (наверное, кажется, возможно, probably, maybe), and no words invented to complete an unfinished phrase.
- NEVER translate. The output language must match the input language.
- NEVER summarize, shorten, or omit content. Output length must be close to input length.
- NEVER add commentary, headings, or explanations.
- Keep every fact, name, number, and non-filler word.
- Start the output at the same word the input starts at.

Output ONLY the cleaned text.`;

const EXAMPLES = `Example input:
<transcript>Даже не список компонентов, мне нужно будет... рассказать админам, что мне нужно от них. И у тебя есть доступ к, э-э, Тенанту, у тебя есть доступ к Девтенанту и к дев Азжуру. Например, я могу запровиженить ресурсы в, э-э, Азжур.</transcript>

Example output:
Даже не список компонентов — мне нужно будет рассказать админам, что мне нужно от них. У тебя есть доступ к tenant, у тебя есть доступ к dev tenant и к dev Azure. Например, я могу запровижинить ресурсы в Azure.

Example input:
<transcript>Ну, вот, как бы, мы обсуждали, э-э, Пауэр Аутомейт, и, ну, решили что, вот, надо делать flow.</transcript>

Example output:
Мы обсуждали Power Automate и решили, что надо делать flow.

Example input (an abandoned phrase is deleted, not completed; no greeting is added):
<transcript>Мне нужно будет список... Даже не список компонентов, мне нужно будет... рассказать админам. Для этого нужны будут права... помощь глобал-админов.</transcript>

Example output:
Даже не список компонентов — мне нужно рассказать админам. Для этого нужна помощь Global Admin.

Example input:
<transcript>So, um, yeah, the Copilot Studio, uh, agent needs to, like, connect to Entra, right?</transcript>

Example output:
The Copilot Studio agent needs to connect to Entra.

Follow this exact pattern. Output cleaned text only.`;

/**
 * Builds the system prompt, embedding the keyterm list as a spelling glossary
 * so the model has the canonical Latin-script form of every term we care about.
 */
export function buildSystemPrompt(keyterms = []) {
  const terms = keyterms.filter((t) => typeof t === 'string' && t.trim());
  const glossary = terms.length
    ? `\n\nGlossary — if any of these appear, including transliterated into Cyrillic, spell them exactly like this:\n${terms.join(', ')}`
    : '';
  return `${RULES}${glossary}\n\n${EXAMPLES}`;
}

/**
 * Sends the transcript to the cleanup model and returns the cleaned text.
 * Long transcripts are split and cleaned chunk by chunk.
 *
 * Throws on any problem (HTTP error, truncated response, suspiciously short
 * output) so the caller can fall back to the raw transcript.
 *
 * @param {object} opts
 * @param {string} opts.endpoint  Foundry resource base, e.g.
 *   "https://<your-foundry-resource>.openai.azure.com" (no trailing slash), or a
 *   full chat-completions URL.
 * @param {string} opts.apiKey    Foundry API key (sent as a Bearer token).
 * @param {string} opts.model     Deployment/model name, e.g. "Phi-4".
 * @param {string} opts.text      Raw transcript to clean.
 * @param {string[]} [opts.keyterms] Canonical spellings for the glossary.
 * @returns {Promise<string>} Cleaned transcript.
 */
export async function cleanTranscript({ endpoint, apiKey, model, text, keyterms }) {
  const systemPrompt = buildSystemPrompt(keyterms);
  const chunks = chunkText(text, MAX_CHUNK_CHARS);
  const cleaned = [];

  for (const chunk of chunks) {
    cleaned.push(await cleanChunk({ endpoint, apiKey, model, systemPrompt, chunk }));
  }
  return cleaned.join(' ').trim();
}

async function cleanChunk({ endpoint, apiKey, model, systemPrompt, chunk }) {
  const res = await fetch(buildUrl(endpoint), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `<transcript>${chunk}</transcript>` },
      ],
      // Generous headroom: the output should be about the same size as the
      // input, and a chunk is capped at MAX_CHUNK_CHARS.
      max_tokens: 4096,
      temperature: 0,
      top_p: 0.1,
      presence_penalty: 0,
      frequency_penalty: 0,
      model,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Transcript cleanup failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const cleaned = choice?.message?.content?.trim();

  if (!cleaned) {
    throw new Error('Transcript cleanup returned empty content.');
  }
  // A "length" stop means the model ran out of output budget mid-transcript;
  // the text we got back is silently truncated and must not be used.
  if (choice.finish_reason === 'length') {
    throw new Error('Transcript cleanup hit the output token limit (truncated).');
  }
  // A small model asked to "clean" sometimes summarizes instead. Cleaning drops
  // fillers, not content, so a large shrink means it did the wrong job.
  if (cleaned.length < chunk.length * MIN_LENGTH_RATIO) {
    throw new Error(
      `Transcript cleanup shrank the text too much (${chunk.length} -> ${cleaned.length} chars); ` +
      'the model likely summarized instead of cleaning.',
    );
  }

  // Insertions are the dangerous failure mode: a hallucinated "наверное" adds
  // hedging the speaker never expressed, and the text reads as authentic. The
  // prompt forbids it, but a small model doesn't reliably comply, so check.
  const repaired = stripHallucinatedLead(cleaned, chunk);
  const inserted = findInsertedWords(repaired, chunk);
  if (inserted.length > 0) {
    throw new Error(
      `Transcript cleanup invented words the speaker did not say: ${inserted.join(', ')}.`,
    );
  }
  return repaired;
}

// Openers a model bolts onto a transcript that didn't have one. Stripped only
// when the source didn't start that way — never when the speaker really said it.
const HALLUCINATED_LEADS = new Set([
  'привет', 'здравствуйте', 'здравствуй', 'добрый', 'итак', 'и', 'а', 'так', 'ну',
  'hi', 'hello', 'hey', 'so', 'well', 'ok', 'okay',
]);

/**
 * Drops a greeting or connector the model prepended. Deterministic and
 * unambiguous, so we repair rather than reject the whole chunk over it.
 */
export function stripHallucinatedLead(cleaned, source) {
  const first = (t) => (t.match(/[\p{L}\p{N}\-]+/u) || [''])[0].toLowerCase();
  const cleanedFirst = first(cleaned);
  if (!cleanedFirst || cleanedFirst === first(source)) return cleaned;
  if (!HALLUCINATED_LEADS.has(cleanedFirst)) return cleaned;

  // Drop the token plus its trailing punctuation/space, then restore the case
  // of whatever now leads the sentence.
  const stripped = cleaned
    .replace(/^[^\p{L}\p{N}]*[\p{L}\p{N}\-]+[\s,.!—–-]*/u, '')
    .trimStart();
  if (!stripped) return cleaned;
  return stripped[0].toUpperCase() + stripped.slice(1);
}

/**
 * Returns Cyrillic content words the model added that aren't explained by the
 * source. Latin-script words are skipped — restoring them to Latin is the whole
 * point of the pass. A word with a near-match in the source is skipped too,
 * since that's a spelling correction we asked for ("запровиженить" ->
 * "запровижинить"), not an invention. Short function words are skipped because
 * their counts shift with ordinary punctuation repair.
 */
export function findInsertedWords(cleaned, source) {
  const tokens = (t) => (t.toLowerCase().match(/[\p{L}\p{N}\-]+/gu) || []);
  const sourceWords = tokens(source);
  const counts = new Map();
  for (const w of sourceWords) counts.set(w, (counts.get(w) || 0) + 1);

  const seen = new Map();
  const inserted = [];
  for (const w of tokens(cleaned)) {
    seen.set(w, (seen.get(w) || 0) + 1);
    if (seen.get(w) <= (counts.get(w) || 0)) continue;   // accounted for
    if (w.length < 4) continue;                          // function word noise
    if (!/\p{Script=Cyrillic}/u.test(w)) continue;        // Latin = intended
    if (sourceWords.some((sw) => withinEditDistance(w, sw, 3))) continue;
    if (!inserted.includes(w)) inserted.push(w);
  }
  return inserted;
}

/** Levenshtein distance, short-circuited once it exceeds `max`. */
function withinEditDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, row[j]);
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * Splits text into chunks of at most `max` characters, preferring to break
 * after sentence-ending punctuation so the model always sees whole sentences.
 */
export function chunkText(text, max) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return [trimmed];

  const chunks = [];
  let remaining = trimmed;
  while (remaining.length > max) {
    const window = remaining.slice(0, max);
    // Last sentence end within the window; fall back to a space, then a hard cut.
    let cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    );
    cut = cut > 0 ? cut + 1 : window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildUrl(endpoint) {
  const base = endpoint.replace(/\/+$/, '');
  if (base.includes('/chat/completions')) return base;
  if (base.includes('/openai/v1')) return `${base}/chat/completions`;
  return `${base}/openai/v1/chat/completions`;
}
