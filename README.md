# local-russian-tts

A personal Telegram bot that transcribes **voice messages, video notes, and audio
files** using **Azure AI Speech fast transcription** with the **MAI-Transcribe-2**
model. It runs on an **Azure Functions Consumption plan** (Windows, Node.js 24) and
is locked to a single Telegram user.

Optimized for speech that is mostly Russian or English-with-a-Russian-accent, with
a static **phrase list** to bias recognition toward names/jargon.

## How it works

```
Telegram voice/video/audio  →  HTTP-triggered Azure Function (webhook)
   →  verify secret + owner  →  download file from Telegram (≤20 MB)
   →  transcode to WAV if needed (ffmpeg)
   →  POST to Azure Speech fast transcription (MAI-Transcribe-2, with phrase list)
   →  (optional) clean transcript with a Foundry chat model (Phi-4)
   →  reply with transcript
```

> **What MAI-Transcribe can't do:** channel (stereo) separation, translation,
> and prompt-tuning are unsupported (MAI-Transcribe-2 added speaker diarization
> and word-level timestamps, but single-speaker voice notes don't need either).
> Those need the non-MAI
> **LLM Speech enhanced** model — which, notably, *does* accept a `prompt`, so it
> could be told "don't transliterate English technical terms into Cyrillic"
> directly at recognition time instead of repairing it downstream. Worth an A/B
> if the cleanup pass ever stops being enough.

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
| `LANGUAGE_CODE` | optional | Locale hint. MAI-Transcribe's docs use bare codes (`ru`, `en`); BCP-47 (`ru-RU`) also works. **Leave empty for auto-detect — best for mixed RU/EN.** |
| `AZURE_SPEECH_MODEL` | optional | Defaults to `MAI-Transcribe-2` (released 2026-09-03). Set to `mai-transcribe-1.5` to fall back to the previous model, which is still live; `mai-transcribe-1` was deprecated 2026-08-20. |
| `AZURE_TRANSCRIBE_STYLE` | optional | Set to `verbatim` to keep fillers/disfluencies. **Leave empty** (or `clean`) for the readability-optimized transcript. Any other value is ignored rather than sent, so a typo can't silently degrade every transcript. The code maps this onto whichever request field the selected model expects (see the phrase-list/style note below). |
| `AZURE_PHRASE_LIST_MAX` | optional | Phrase-list size sent to MAI-Transcribe. Defaults to `50`, which is MAI-Transcribe-2's hard cap; `mai-transcribe-1.5` accepts `200`. Run `npm run probe-phrase-limit` to check your resource. |
| `LOG_RAW_TRANSCRIPT` | optional | Set to `1` to log the raw pre-cleanup transcript, so a bad word can be blamed on the recognizer vs. the cleanup model. **Off by default — it writes your speech into Application Insights**, the one place this otherwise zero-retention pipeline would persist it. Turn it off again once you've diagnosed the issue. |
| `FFMPEG_PATH` | optional | Explicit path to an ffmpeg binary. Resolution order: `FFMPEG_PATH` → bundled `./bin/ffmpeg(.exe)` → `ffmpeg-static` → `ffmpeg` on PATH. |
| `AZURE_FOUNDRY_ENDPOINT` | optional | Azure Foundry resource base, e.g. `https://<your-foundry-resource>.openai.azure.com`. Enables transcript cleanup (with `AZURE_FOUNDRY_KEY`). |
| `AZURE_FOUNDRY_KEY` | optional | API key for the Foundry resource (sent as a Bearer token). |
| `AZURE_FOUNDRY_MODEL` | optional | Cleanup model/deployment name. Defaults to `Phi-4`. |

> **⚠️ Preview:** MAI-Transcribe is still in **public preview** — no SLA, and
> behavior can change without notice.

All of these are stored as **App Settings** in the Function App — free, no Key Vault
needed. They are read from environment variables at runtime.

> *Provide **either** `AZURE_SPEECH_ENDPOINT` (full URL — simplest, just paste the
> portal's Endpoint field) **or** `AZURE_SPEECH_RESOURCE` (bare name). If both are
> set, `AZURE_SPEECH_ENDPOINT` wins. The fast-transcription API is documented
> against the custom-subdomain host (`{name}.cognitiveservices.azure.com`); if your
> regional endpoint returns 404, set `AZURE_SPEECH_RESOURCE` to the resource name
> instead.

> **⚠️ Region:** MAI-Transcribe (enhanced mode) is only available in
> **Central India**, **East US**, **North Europe**, **Southeast Asia**,
> **West US**, and **West US 2**. Create the
> Speech resource in one of these — other regions return
> `HTTP 400 "Enhanced mode with model is currently not supported yet."`
> ([region list](https://learn.microsoft.com/azure/ai-services/speech-service/regions?tabs=llmspeech)).

> **Note on the phrase list:** `keyterms.json` does double duty. Its first
> `AZURE_PHRASE_LIST_MAX` entries (default **50**) are sent as the MAI-Transcribe
> [phrase list](https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe)
> (only MAI-Transcribe models support this); the **whole** file is handed to the
> cleanup model as a spelling glossary, so terms past the cap still get their
> canonical Latin-script form enforced. Put the terms the recognizer actually
> gets wrong at the top.
>
> The 50 cap is real for MAI-Transcribe-2: it returns `HTTP 400 "Context list
> cannot have more than 50 items."` above that (probed 2026-09-05, North
> Europe), while `mai-transcribe-1.5` accepts up to **200**. Run
> `npm run probe-phrase-limit` against your own resource to find the true
> ceiling; only raise `AZURE_PHRASE_LIST_MAX` if you switch back to 1.5.
>
> **Note on transcript style (2 vs 1.5):** the two models disagree on the wire
> format, and the code hides that behind `AZURE_TRANSCRIBE_STYLE`.
> MAI-Transcribe-2 takes `enhancedMode.modelOptions.transcribeStyle` =
> `clean` | `verbatim` and **defaults to verbatim**, so the readability
> transcript is always requested explicitly as `clean`. `mai-transcribe-1.5`
> rejects `modelOptions` outright (`HTTP 400 "transcribeStyle='clean' is not
> supported by MAI transcription model 'mai-transcribe-1.5'"`) and uses the
> older `enhancedMode.transcribeStyle`, where readability is the omitted
> default and only `verbatim` is sent. In practice the Phi-4 cleanup pass
> still does the heavy lifting on fillers — on a synthesized test clip neither
> model's readability mode removed deliberate "эээ"/"ну" tokens.
>
> **Note on data retention:** the synchronous fast-transcription endpoint processes
> audio in-flight and does **not** store the audio or transcript (unlike batch
> transcription), so it is effectively zero-retention by default — no flag needed.

> **Note on transcript cleanup:** when `AZURE_FOUNDRY_ENDPOINT` and
> `AZURE_FOUNDRY_KEY` are set, the raw transcript is sent to a Foundry chat model
> (default **Phi-4**), and only the cleaned text is sent to Telegram. It does two
> jobs:
>
> 1. Strips fillers, hesitations, and false starts.
> 2. **Restores English technical terms that MAI-Transcribe transliterated into
>    Cyrillic** — `Азжур` → `Azure`, `Тенант` → `tenant`, `Шерпоинт` →
>    `SharePoint`. The phrase list *cannot* fix these: the recognizer already
>    understood the word and then declined it into a Russian case, so there was
>    no Latin-script form it could have emitted. It has to be repaired
>    downstream. (Russian verbs derived from English — `запровижинить`,
>    `задеплоить` — are deliberately left in Cyrillic; only their spelling is
>    fixed.)
>
> Long transcripts are chunked at sentence boundaries so nothing overruns the
> model's context or output budget. A response that comes back truncated
> (`finish_reason: "length"`) or suspiciously short — a small model asked to
> "clean" sometimes summarizes instead — is **rejected**, and the raw transcript
> is sent instead of a silently mangled one.
>
> **Insertions are the dangerous failure mode.** A hedge like `наверное` that
> the speaker never used changes the meaning while still reading as authentic.
> The prompt forbids adding words (and, symmetrically, forbids deleting a
> greeting or hedge that *is* in the input — those are content, not filler), but
> a small model doesn't reliably comply, so two code-level guards run on every
> response. **Both compare against the raw transcript from the same run**, never
> against an earlier one — two runs of the same audio differ on their own, so
> only the same-run baseline can attribute a word to the cleanup model:
>
> - A prepended greeting or connector (`Привет`, `И`, `So`, …) is **stripped**,
>   but only when the raw transcript didn't start that way. A greeting the
>   speaker actually said is kept. Deterministic, so it's repaired not rejected.
> - Any **Cyrillic** word the model added that has no near-match in the source
>   (edit distance ≤ 3, which lets through the spelling corrections we asked for,
>   like `запровиженить` → `запровижинить`) causes the chunk to be **rejected**.
>   Latin-script additions are skipped — restoring those is the point of the pass.
>
> Known gap: a fabricated word that already appears elsewhere in the transcript
> slips past the second guard, because it looks accounted-for. Completing an
> abandoned false start (`Мне нужно будет список...` → `...список компонентов`)
> is the case to watch. Only the prompt defends against that one.
>
> Because that fallback is invisible from the chat side, every invocation logs
> its outcome: `Cleanup: ok via Phi-4 (1240 → 1080 chars)`, `Cleanup: skipped
> (...)`, or `Cleanup: FAILED via Phi-4, ... — <reason>` at **error** level.
> Check Application Insights if transcripts suddenly look uncleaned.

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
   model catalog or the portal) in a region where **MAI-Transcribe** is available
   — **Central India**, **East US**, **North Europe**, **Southeast Asia**,
   **West US**, or **West US 2**. No model deployment is needed: the Foundry
   catalog entry (`azureml://registries/azureml-cogsvc/models/MAI-Transcribe-2`)
   is informational; the Speech REST API selects the model by name per request. From its
   *Keys and Endpoint* blade, copy a **key** (`AZURE_SPEECH_KEY`) and the **Endpoint**
   URL (`AZURE_SPEECH_ENDPOINT`).
2. Create a **Function App**:
   - Plan: **Consumption**, OS: **Windows**, Runtime: **Node.js 24 LTS**
   - It will create an associated Storage account automatically.

Then add the App Settings from the table above (Function App → *Settings →
Environment variables*).

### 2. Deploy

**Push to `main` and the `main_anton-tts.yml` GitHub Actions workflow deploys
automatically.** It builds on `windows-latest`, so `npm install` fetches the
correct Windows `ffmpeg.exe` via `ffmpeg-static` — no `fetch-ffmpeg` step needed
on this path.

#### Manual fallback (Azure Cloud Shell)

If Actions is unavailable, deploy by hand with the Azure Functions Core Tools.
From [Azure Cloud Shell](https://shell.azure.com) (already authenticated):

```bash
git clone https://github.com/antontru/russian-stt-telegram-mai-1.5.git
cd russian-stt-telegram-mai-1.5
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

> The manual path builds on Linux, which is why `fetch-ffmpeg` is needed there but
> not in CI.

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

Edit the `keyterms` array in `keyterms.json` and push to `main` — it ships with
the code, so a redeploy is required; an app-setting change alone won't pick it up.

Order matters: the first `AZURE_PHRASE_LIST_MAX` entries (default 50) become the
MAI-Transcribe phrase list, and the rest are glossary-only. The file is grouped
accordingly — Microsoft product names, then the cloud/delivery nouns that get
transliterated into Cyrillic, then acronyms, then client names.

To check whether your resource accepts more than 50:

```bash
AZURE_SPEECH_KEY=... AZURE_SPEECH_ENDPOINT=https://<resource>.cognitiveservices.azure.com npm run probe-phrase-limit
```

## Run locally (optional)

Requires the [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
cp local.settings.json.example local.settings.json   # fill in your values
npm install
npm start
```

Expose the local port with a tunnel (e.g. `ngrok`) and point the webhook at it to
test end-to-end.
