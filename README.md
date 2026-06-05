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
   →  POST to Azure Speech fast transcription (MAI-Transcribe-1.5, with phrase list)
   →  reply with transcript
```

- **Function code:** `src/functions/transcribe.js` (route: `POST /api/telegram`)
- **Telegram/Azure Speech helpers:** `src/telegram.js`, `src/azure-speech.js`
- **Phrase list (key terms):** `keyterms.json` (static list, edit + redeploy to change)

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

All of these are stored as **App Settings** in the Function App — free, no Key Vault
needed. They are read from environment variables at runtime.

> *Provide **either** `AZURE_SPEECH_ENDPOINT` (full URL — simplest, just paste the
> portal's Endpoint field) **or** `AZURE_SPEECH_RESOURCE` (bare name). If both are
> set, `AZURE_SPEECH_ENDPOINT` wins. The fast-transcription API is documented
> against the custom-subdomain host (`{name}.cognitiveservices.azure.com`); if your
> regional endpoint returns 404, set `AZURE_SPEECH_RESOURCE` to the resource name
> instead.

> **Note on the phrase list:** `keyterms.json` is sent as the MAI-Transcribe
> [phrase list](https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe)
> (only MAI-Transcribe models support this). The client sends at most **200** phrases.
>
> **Note on data retention:** the synchronous fast-transcription endpoint processes
> audio in-flight and does **not** store the audio or transcript (unlike batch
> transcription), so it is effectively zero-retention by default — no flag needed.

## One-time setup

### 1. Create the Azure resources

In the [Azure portal](https://portal.azure.com) (or CLI):

1. Create an **Azure AI Speech** resource (from the [AI Foundry](https://ai.azure.com)
   model catalog or the portal) in a region where **MAI-Transcribe-1.5** is available.
   From its *Keys and Endpoint* blade, copy a **key** (`AZURE_SPEECH_KEY`) and the
   **Endpoint** URL (`AZURE_SPEECH_ENDPOINT`).
2. Create a **Function App**:
   - Plan: **Consumption**, OS: **Windows**, Runtime: **Node.js 24 LTS**
   - It will create an associated Storage account automatically.

Then add the App Settings from the table above (Function App → *Settings →
Environment variables*).

### 2. Configure CI/CD deploy (GitHub Actions)

The workflow `.github/workflows/deploy.yml` deploys on every push to `main`.

1. In the Function App, download the **publish profile**
   (*Overview → Get publish profile*).
2. In GitHub → *Settings → Secrets and variables → Actions*:
   - Add a **secret** `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` = the publish profile XML.
   - Add a **variable** `AZURE_FUNCTIONAPP_NAME` = your Function App name.
3. Push to `main` (or run the workflow manually via *Actions → Run workflow*).

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
redeploys automatically. The first 200 entries are sent as the MAI-Transcribe
phrase list.

## Run locally (optional)

Requires the [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
cp local.settings.json.example local.settings.json   # fill in your values
npm install
npm start
```

Expose the local port with a tunnel (e.g. `ngrok`) and point the webhook at it to
test end-to-end.
