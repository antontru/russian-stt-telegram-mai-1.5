// Downloads a static win64 ffmpeg.exe into ./bin so it ships in the deploy
// package for the (Windows) Azure Function App.
//
// Why: the app transcodes WebM/M4A/MP4 to WAV with ffmpeg. The `ffmpeg-static`
// npm package only provides a binary for the OS it was installed on — and we
// deploy manually from Linux (Cloud Shell) to a Windows app, so its Linux
// binary won't run there. Run this once before `func azure functionapp publish`
// to bundle the correct Windows ffmpeg.exe (src/audio.js prefers ./bin).
//
// Usage:  node scripts/fetch-ffmpeg.mjs   (or: npm run fetch-ffmpeg)
// Requires `unzip` on PATH (preinstalled in Azure Cloud Shell).

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZIP_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const zipPath = join(tmpdir(), 'ffmpeg-win64.zip');

console.log(`Downloading ${ZIP_URL} ...`);
const res = await fetch(ZIP_URL);
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

mkdirSync('bin', { recursive: true });
// -j: flatten paths, -o: overwrite. Extract only ffmpeg.exe from the archive.
const unzip = spawnSync('unzip', ['-j', '-o', zipPath, '*/bin/ffmpeg.exe', '-d', 'bin'], {
  stdio: 'inherit',
});
if (unzip.status !== 0) {
  console.error('unzip failed (is the `unzip` command installed?).');
  process.exit(1);
}

const out = 'bin/ffmpeg.exe';
if (!existsSync(out)) {
  console.error('ERROR: ffmpeg.exe was not extracted.');
  process.exit(1);
}
console.log(`OK: ${out} ready (${(statSync(out).size / 1e6).toFixed(0)} MB). It will ship with the next deploy.`);
