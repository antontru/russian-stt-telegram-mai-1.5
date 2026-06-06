// Post-processing: clean a raw transcript with a chat model on Azure Foundry
// (Azure OpenAI v1 API), removing fillers/hesitations/false starts while
// preserving language, meaning, names, and terminology.

const SYSTEM_PROMPT = `You are a transcript cleaner. You receive text between <transcript> and </transcript> tags. Your ONLY task: remove filler words, hesitations, false starts, and disfluencies. Preserve the original language, meaning, all names, and terminology exactly. Output ONLY the cleaned text. No commentary, no greetings, no explanations.

Example input:
<transcript>Ну, вот, как бы, мы обсуждали, э-э, Power Automate, и, ну, решили что, вот, надо делать flow.</transcript>

Example output:
Мы обсуждали Power Automate и решили, что надо делать flow.

Example input:
<transcript>So, um, yeah, the Copilot Studio, uh, agent needs to, like, connect to Entra, right?</transcript>

Example output:
The Copilot Studio agent needs to connect to Entra.

Follow this exact pattern. Output cleaned text only.`;

/**
 * Sends the transcript to the cleanup model and returns the cleaned text.
 *
 * @param {object} opts
 * @param {string} opts.endpoint  Foundry resource base, e.g.
 *   "https://russian-tts-resource.openai.azure.com" (no trailing slash), or a
 *   full chat-completions URL.
 * @param {string} opts.apiKey    Foundry API key (sent as a Bearer token).
 * @param {string} opts.model     Deployment/model name, e.g. "Phi-4".
 * @param {string} opts.text      Raw transcript to clean.
 * @returns {Promise<string>} Cleaned transcript.
 */
export async function cleanTranscript({ endpoint, apiKey, model, text }) {
  const res = await fetch(buildUrl(endpoint), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `<transcript>${text}</transcript>` },
      ],
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
  const cleaned = data.choices?.[0]?.message?.content?.trim();
  if (!cleaned) {
    throw new Error('Transcript cleanup returned empty content.');
  }
  return cleaned;
}

function buildUrl(endpoint) {
  const base = endpoint.replace(/\/+$/, '');
  if (base.includes('/chat/completions')) return base;
  if (base.includes('/openai/v1')) return `${base}/chat/completions`;
  return `${base}/openai/v1/chat/completions`;
}
