# local-russian-tts

A personal Telegram bot that transcribes **voice messages, video notes, and audio
files** using **Azure AI Speech fast transcription** with the **MAI-Transcribe-1.5**
model. It runs on an **Azure Functions Consumption plan** (Windows, Node.js 24) and
is locked to a single Telegram user.

Optimized for speech that is mostly Russian or English-with-a-Russian-accent, with
a static **phrase list** to bias recognition toward names/jargon.

## How it works

```
Telegram voice/video/audio  →  HTTP-triggered Azure Function (webhook)
   →  verify secret + owner  →  download file from Telegram (≤20 MB)
   →  transcode to WAV if needed (ffmpeg)
   →  POST to Azure Speech fast transcription (MAI-Transcribe-1.5, with phrase list)
   →  (optional) clean transcript with a Foundry chat model (Phi-4)
   →  reply with transcript
```

- **Function code:** `src/functions/transcribe.js` (route: `POST /api/telegram`)
- **Telegram/Azure Speech helpers:** `src/telegram.js`, `src/azure-speech.js`
- **Transcoding:** `src/audio.js` (ffmpeg via `ffmpeg-static`)
- **Phrase list (key terms):** `keyterms.json` (static list, edit + redeploy to change)
- **Supported formats:** WAV, MP3, FLAC, and OGG/Opus (Telegram voice) go straight to
  Azure; everything else (WebM, M4A/Apple Voice Memos, MP4 video notes, AMR, AAC, …)
  is transcoded to 16 kHz mono WAV first, since MAI-Transcribe only accepts
  WAV/MP3/FLAC/OGG.

## Configuration (Azure Function App Settings)

| Setting | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | From [@BotFather](https://t.me/BotFather). |
| `AZURE_SPEECH_KEY` | ✅ | KEY 1 (or KEY 2) from the resource's *Keys and Endpoint* blade. |
| `AZURE_SPEECH_ENDPOINT` | ✅* | The **Endpoint** URL from *Keys and Endpoint*, e.g. `https://westeurope.api.cognitive.microsoft.com/`. |
| `AZURE_SPEECH_RESOURCE` | ✅* | Alternative to `AZURE_SPEECH_ENDPOINT`: the resource **name** (maps to `https://{name}.cognitiveservices.azure.com`). |
| `ALLOWED_USER_ID` | recommended | Your numeric Telegram user id ([@userinfobot](https://t.me/userinfobot)). Others are ignored. |
| `TELEGRAM_SECRET_TOKEN` | recommended | Random string; verifies calls really come from Telegram. |
| `LANGUAGE_CODE` | optional | BCP-47 locale hint (`ru-RU`/`en-US`). Leave empty for auto-detect (best for mixed RU/EN). |
| `AZURE_SPEECH_MODEL` | optional | Defaults to `mai-transcribe-1.5`. |
| `AZURE_TRANSCRIBE_STYLE` | optional | Set to `verbatim` to keep fillers/disfluencies. Leave empty for the default cleaned transcript. |
| `FFMPEG_PATH` | optional | Explicit path to an ffmpeg binary. Resolution order: `FFMPEG_PATH` → bundled `./bin/ffmpeg(.exe)` → `ffmpeg-static` → `ffmpeg` on PATH. |
| `AZURE_FOUNDRY_ENDPOINT` | optional | Azure Foundry resource base, e.g. `https://russian-tts-resource.openai.azure.com`. Enables transcript cleanup (with `AZURE_FOUNDRY_KEY`). |
| `AZURE_FOUNDRY_KEY` | optional | API key for the Foundry resource (sent as a Bearer token). |
| `AZURE_FOUNDRY_MODEL` | optional | Cleanup model/deployment name. Defaults to `Phi-4`. |

All of these are stored as **App Settings** in the Function App — free, no Key Vault
needed. They are read from environment variables at runtime.

> *Provide **either** `AZURE_SPEECH_ENDPOINT` (full URL — simplest, just paste the
> portal's Endpoint field) **or** `AZURE_SPEECH_RESOURCE` (bare name). If both are
> set, `AZURE_SPEECH_ENDPOINT` wins. The fast-transcription API is documented
> against the custom-subdomain host (`{name}.cognitiveservices.azure.com`); if your
> regional endpoint returns 404, set `AZURE_SPEECH_RESOURCE` to the resource name
> instead.

> **⚠️ Region:** MAI-Transcribe-1.5 (enhanced mode) is only available in
> **East US**, **North Europe**, **West US**, and **Southeast Asia**. Create the
> Speech resource in one of these — other regions return
> `HTTP 400 "Enhanced mode with model is currently not supported yet."`
> ([region list](https://learn.microsoft.com/azure/ai-services/speech-service/regions?tabs=llmspeech)).

> **Note on the phrase list:** `keyterms.json` is sent as the MAI-Transcribe
> [phrase list](https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe)
> (only MAI-Transcribe models support this). MAI-Transcribe caps the list at
> **50** items, so the client sends only the first 50.
>
> **Note on data retention:** the synchronous fast-transcription endpoint processes
> audio in-flight and does **not** store the audio or transcript (unlike batch
> transcription), so it is effectively zero-retention by default — no flag needed.

> **Note on transcript cleanup:** when `AZURE_FOUNDRY_ENDPOINT` and
> `AZURE_FOUNDRY_KEY` are set, the raw transcript is sent to a Foundry chat model
> (default **Phi-4**) that strips fillers/hesitations/false starts while preserving
> language, meaning, names, and terminology — and only the cleaned text is sent to
> Telegram. If cleanup is unconfigured or fails, the raw transcript is sent instead.

> **Note on transcoding / ffmpeg:** WebM/M4A/MP4 are transcoded to WAV with ffmpeg.
> Because we deploy manually from Linux (Cloud Shell) to a **Windows** app, the
> `ffmpeg-static` Linux binary won't run there — so run `npm run fetch-ffmpeg`
> before deploying to drop a **Windows** `ffmpeg.exe` into `./bin`, which ships in
> the package (`src/audio.js` prefers `./bin`, then `FFMPEG_PATH`, then
> `ffmpeg-static`). See *Deploy* below.

## One-time setup

### 1. Create the Azure resources

In the [Azure portal](https://portal.azure.com) (or CLI):

1. Create an **Azure AI Speech** resource (from the [AI Foundry](https://ai.azure.com)
   model catalog or the portal) in a region where **MAI-Transcribe-1.5** is available
   — **East US**, **North Europe**, **West US**, or **Southeast Asia**. From its
   *Keys and Endpoint* blade, copy a **key** (`AZURE_SPEECH_KEY`) and the **Endpoint**
   URL (`AZURE_SPEECH_ENDPOINT`).
2. Create a **Function App**:
   - Plan: **Consumption**, OS: **Windows**, Runtime: **Node.js 24 LTS**
   - It will create an associated Storage account automatically.

Then add the App Settings from the table above (Function App → *Settings →
Environment variables*).

### 2. Deploy (manual, from Azure Cloud Shell)

We deploy by hand with the Azure Functions Core Tools — no GitHub Actions needed.
From [Azure Cloud Shell](https://shell.azure.com) (already authenticated):

```bash
git clone https://github.com/antontru/local-russian-tts.git
cd local-russian-tts
npm ci --omit=dev
npm run fetch-ffmpeg        # downloads a Windows ffmpeg.exe into ./bin
func azure functionapp publish anton-tts --javascript
```

- `fetch-ffmpeg` is required because the app runs on **Windows** but Cloud Shell is
  Linux; it bundles the correct `ffmpeg.exe` (needs `unzip`, preinstalled in Cloud
  Shell). Re-run it only when you want to refresh ffmpeg.
- `--javascript` is needed in a fresh clone (the runtime hint lives in the
  gitignored `local.settings.json`).
- App-setting changes (keys, endpoint, keyterms) take effect without a redeploy;
  code/keyterms changes require re-running `func ... publish`.

> A `main_anton-tts.yml` GitHub Actions workflow also exists (from Azure Deployment
> Center) but is **not used** — GitHub Actions is blocked on this account. Ignore or
> delete it.

### 3. Register the Telegram webhook

After the first deploy, point Telegram at your function:

```bash
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_SECRET_TOKEN=...  # same value as the app setting \
FUNCTION_URL=https://<your-app>.azurewebsites.net/api/telegram \
node scripts/set-webhook.js
```

To remove it: `TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.js --delete`

That's it — send the bot a voice message and it replies with the transcription.

## Editing the phrase list

Edit the `keyterms` array in `keyterms.json` and push to `main`; the workflow
redeploys automatically. The first 50 entries are sent as the MAI-Transcribe
phrase list (the model's maximum).

## Run locally (optional)

Requires the [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
cp local.settings.json.example local.settings.json   # fill in your values
npm install
npm start
```

Expose the local port with a tunnel (e.g. `ngrok`) and point the webhook at it to
test end-to-end.
