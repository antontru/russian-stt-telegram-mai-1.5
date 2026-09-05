#!/usr/bin/env node
// Finds the real MAI-Transcribe phrase-list ("context list") ceiling for your
// Speech resource.
//
// The ceiling depends on the model: MAI-Transcribe-2 returns
//   HTTP 400 "Context list cannot have more than 50 items."
// while mai-transcribe-1.5 accepts up to 200 (both probed 2026-09-05, North
// Europe). Rather than guess, ask the service: this sends a one-second silent
// WAV with progressively larger phrase lists and reports which sizes are
// accepted.
//
// Usage:
//   AZURE_SPEECH_KEY=... AZURE_SPEECH_ENDPOINT=https://<res>.cognitiveservices.azure.com \
//     node scripts/probe-phrase-limit.mjs
//
// Optional: AZURE_SPEECH_MODEL (default MAI-Transcribe-2).
// A silent clip transcribes to nothing, which is fine — we only care whether
// the request is accepted or rejected on the phrase-list count.

const API_VERSION = '2025-10-15';
const SIZES = [50, 100, 128, 200, 256, 500, 1000];

const key = process.env.AZURE_SPEECH_KEY;
const endpointRaw = process.env.AZURE_SPEECH_ENDPOINT || process.env.AZURE_SPEECH_RESOURCE;
const model = process.env.AZURE_SPEECH_MODEL || 'MAI-Transcribe-2';

if (!key || !endpointRaw) {
  console.error('Set AZURE_SPEECH_KEY and AZURE_SPEECH_ENDPOINT (or AZURE_SPEECH_RESOURCE).');
  process.exit(1);
}

const endpoint = resolveEndpoint(endpointRaw);
const audio = silentWav(1);

console.log(`Probing ${endpoint} with model ${model}\n`);

let best = 0;
for (const size of SIZES) {
  const result = await attempt(size);
  const label = String(size).padStart(5);
  if (result.ok) {
    best = size;
    console.log(`${label} phrases  ✅ accepted`);
  } else {
    console.log(`${label} phrases  ❌ HTTP ${result.status}  ${result.detail}`);
    // Keep going: a non-400 failure (throttling, transient) shouldn't end the run.
    if (result.status === 400) break;
  }
}

console.log(
  best
    ? `\nLargest accepted phrase list: ${best}.` +
      (best > 50 ? `  Set AZURE_PHRASE_LIST_MAX=${best} to use it.` : '  The 50-item default stands.')
    : '\nNo size was accepted — check the key, endpoint, region, and model.',
);

async function attempt(size) {
  // Distinct, plausible-looking phrases so nothing is rejected as a duplicate.
  const phrases = Array.from({ length: size }, (_, i) => `Contoso Term ${i + 1}`);
  const definition = {
    enhancedMode: { enabled: true, model },
    phraseList: { phrases },
  };

  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'probe.wav');
  form.append('definition', JSON.stringify(definition));

  const res = await fetch(
    `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key }, body: form },
  );
  if (res.ok) return { ok: true };
  const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  return { ok: false, status: res.status, detail };
}

function resolveEndpoint(value) {
  const v = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.includes('.') ? v : `${v}.cognitiveservices.azure.com`}`;
}

/** Builds `seconds` of 16 kHz mono 16-bit silence as a WAV buffer. */
function silentWav(seconds) {
  const sampleRate = 16000;
  const dataBytes = sampleRate * 2 * seconds;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM header size
  buf.writeUInt16LE(1, 20);           // format: PCM
  buf.writeUInt16LE(1, 22);           // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;                          // samples stay zeroed = silence
}
