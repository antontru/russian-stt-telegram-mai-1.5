# local-russian-tts

A personal Telegram bot that transcribes **voice messages, video notes, and audio
files** using the **ElevenLabs Scribe v2** API. It runs on an **Azure Functions
Consumption plan** (Windows, Node.js 24) and is locked to a single Telegram user.

Optimized for speech that is mostly Russian or English-with-a-Russian-accent, with
a static list of **key terms** to bias recognition toward names/jargon.

## How it works

```
Telegram voice/video/audio  →  HTTP-triggered Azure Function (webhook)
   →  verify secret + owner  →  download file from Telegram (≤20 MB)
   →  POST to ElevenLabs Scribe v2 (with keyterms)  →  reply with transcript
```

- **Function code:** `src/functions/transcribe.js` (route: `POST /api/telegram`)
- **Telegram/ElevenLabs helpers:** `src/telegram.js`, `src/elevenlabs.js`
- **Key terms:** `keyterms.json` (static list, edit + redeploy to change)

## Configuration (Azure Function App Settings)

| Setting | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | From [@BotFather](https://t.me/BotFather). |
| `ELEVENLABS_API_KEY` | ✅ | From the ElevenLabs dashboard. |
| `ALLOWED_USER_ID` | recommended | Your numeric Telegram user id ([@userinfobot](https://t.me/userinfobot)). Others are ignored. |
| `TELEGRAM_SECRET_TOKEN` | recommended | Random string; verifies calls really come from Telegram. |
| `LANGUAGE_CODE` | optional | ISO 639 hint (`rus`/`eng`). Leave empty for auto-detect (best for mixed RU/EN). |
| `ELEVENLABS_MODEL` | optional | Defaults to `scribe_v2`. |

All of these are stored as **App Settings** in the Function App — free, no Key Vault
needed. They are read from environment variables at runtime.

> **Note on key terms:** using `keyterms.json` adds a **+20% surcharge** on the
> ElevenLabs transcription cost. Limits: up to 1000 terms, each <50 chars / ≤5 words.

## One-time setup

### 1. Create the Azure resources

In the [Azure portal](https://portal.azure.com) (or CLI), create a **Function App**:
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

## Editing key terms

Edit the `keyterms` array in `keyterms.json` and push to `main`; the workflow
redeploys automatically.

## Run locally (optional)

Requires the [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
cp local.settings.json.example local.settings.json   # fill in your values
npm install
npm start
```

Expose the local port with a tunnel (e.g. `ngrok`) and point the webhook at it to
test end-to-end.
