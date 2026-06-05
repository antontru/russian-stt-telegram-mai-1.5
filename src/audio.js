// Transcodes audio that MAI-Transcribe can't ingest into a format it can.
//
// MAI-Transcribe (enhanced mode) only accepts WAV, MP3, FLAC — and, in
// practice, OGG/Opus (Telegram voice notes). Anything else (WebM, M4A/AAC,
// MP4 video notes, AMR, ...) is rejected with HTTP 422 "InvalidAudioFormat",
// so we convert those to 16 kHz mono WAV with ffmpeg before sending.
//
// The ffmpeg binary comes from the `ffmpeg-static` npm package. Because the
// deploy workflow builds on windows-latest, `npm install` fetches the Windows
// ffmpeg.exe and ships it in the deployment artifact. Override with FFMPEG_PATH.

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';

// Formats MAI-Transcribe ingests directly — passed through untouched.
const SUPPORTED_EXT = new Set(['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus']);
const SUPPORTED_MIME = new Set(['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/ogg']);

/**
 * Ensures the audio is in a MAI-Transcribe-supported format, transcoding to
 * 16 kHz mono WAV when it isn't.
 *
 * @param {{bytes: Buffer, filename: string, contentType: string}} media
 * @returns {Promise<{bytes: Buffer, filename: string, contentType: string, converted: boolean}>}
 */
export async function ensureSupported({ bytes, filename, contentType }) {
  if (isSupported(filename, contentType)) {
    return { bytes, filename, contentType, converted: false };
  }
  const wav = await transcodeToWav(bytes);
  return { bytes: wav, filename: 'audio.wav', contentType: 'audio/wav', converted: true };
}

function isSupported(filename, contentType) {
  const ext = extOf(filename);
  // A known extension is authoritative; otherwise fall back to the MIME type.
  if (ext) return SUPPORTED_EXT.has(ext);
  return SUPPORTED_MIME.has((contentType || '').split(';')[0].trim().toLowerCase());
}

function extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

/**
 * Runs ffmpeg to produce 16 kHz mono WAV. The input is written to a temp file
 * first because seekable containers (MP4/M4A) can't be read from a pipe.
 */
async function transcodeToWav(bytes) {
  const input = join(tmpdir(), `tts-${randomUUID()}`);
  await writeFile(input, bytes);
  try {
    return await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vn',            // ignore any video stream (e.g. video notes)
      '-ac', '1',       // mono
      '-ar', '16000',   // 16 kHz
      '-f', 'wav', 'pipe:1',
    ]);
  } finally {
    unlink(input).catch(() => {});
  }
}

function runFfmpeg(args) {
  const bin = resolveFfmpeg();
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, args);
    const out = [];
    const err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', (e) => reject(new Error(`Could not run ffmpeg (${bin}): ${e.message}`)));
    ff.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new Error(`ffmpeg failed (exit ${code}): ${Buffer.concat(err).toString().slice(0, 500)}`));
    });
  });
}

function resolveFfmpeg() {
  const override = process.env.FFMPEG_PATH;
  if (override && existsSync(override)) return override;
  // A binary bundled at ./bin (e.g. a Windows ffmpeg.exe fetched before a
  // manual deploy) wins over ffmpeg-static, which holds a wrong-platform
  // binary when the app is built on a different OS than it runs on (Linux
  // Cloud Shell build → Windows Function App).
  for (const name of ['ffmpeg.exe', 'ffmpeg']) {
    const bundled = fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
    if (existsSync(bundled)) return bundled;
  }
  if (ffmpegStatic && existsSync(ffmpegStatic)) return ffmpegStatic;
  // Last resort: rely on ffmpeg being on PATH.
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}
