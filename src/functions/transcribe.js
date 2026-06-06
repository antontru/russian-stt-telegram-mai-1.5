import { app } from '@azure/functions';
import { getConfig, getKeyterms } from '../config.js';
import { TelegramClient, extractMedia } from '../telegram.js';
import { transcribe } from '../azure-speech.js';
import { ensureSupported } from '../audio.js';
import { cleanTranscript } from '../cleanup.js';

/**
 * Telegram webhook handler. Telegram POSTs an Update object here; we transcribe
 * any voice/video/audio message and reply with the text.
 *
 * We always return HTTP 200 so Telegram does not retry the same update — any
 * problem is reported back to the user as a chat message instead.
 */
async function handler(request, context) {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    context.error(err.message);
    // Misconfiguration: ack so Telegram stops retrying, but log loudly.
    return { status: 200, body: 'ok' };
  }

  // Verify the request came from Telegram via the shared secret token.
  if (config.webhookSecret) {
    const provided = request.headers.get('x-telegram-bot-api-secret-token');
    if (provided !== config.webhookSecret) {
      context.warn('Rejected webhook call with invalid secret token.');
      return { status: 401, body: 'unauthorized' };
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return { status: 200, body: 'ok' };
  }

  const message = update.message || update.edited_message;
  if (!message) {
    return { status: 200, body: 'ok' };
  }

  const telegram = new TelegramClient(config.botToken);
  const chatId = message.chat.id;

  // Personal-use gate: ignore anyone who isn't the configured owner.
  if (config.allowedUserId && String(message.from?.id) !== config.allowedUserId) {
    context.warn(`Ignoring message from unauthorized user ${message.from?.id}.`);
    return { status: 200, body: 'ok' };
  }

  const media = extractMedia(message);
  if (!media) {
    await safeReply(telegram, chatId, message.message_id,
      'Send me a voice message, video note, or audio file and I will transcribe it.');
    return { status: 200, body: 'ok' };
  }

  try {
    await telegram.sendChatAction(chatId, 'typing');

    const downloaded = await telegram.downloadFile(media.fileId, media.mimeType);
    // MAI-Transcribe rejects WebM/M4A/MP4/etc.; transcode those to WAV first.
    const audio = await ensureSupported(downloaded);

    const { text, languageCode } = await transcribe({
      apiKey: config.speechKey,
      endpoint: config.speechEndpoint,
      bytes: audio.bytes,
      filename: audio.filename,
      contentType: audio.contentType,
      model: config.model,
      languageCode: config.languageCode,
      keyterms: getKeyterms(),
      transcribeStyle: config.transcribeStyle,
    });

    const note = audio.converted ? `, transcoded ${downloaded.contentType} → wav` : '';
    context.log(`Transcribed ${media.kind} (${audio.bytes.length} bytes${note}, lang=${languageCode ?? 'auto'}).`);

    // Optional cleanup pass: strip fillers/disfluencies via the Foundry model.
    // On any failure, fall back to the raw transcript so the user still gets text.
    let finalText = text;
    const { endpoint: cleanupEndpoint, apiKey: cleanupKey, model: cleanupModel } = config.cleanup;
    if (cleanupEndpoint && cleanupKey && text.trim()) {
      try {
        finalText = await cleanTranscript({
          endpoint: cleanupEndpoint,
          apiKey: cleanupKey,
          model: cleanupModel,
          text,
        });
        context.log('Transcript cleaned via Foundry post-processing.');
      } catch (err) {
        context.warn(`Cleanup failed, sending raw transcript: ${err.message}`);
      }
    }

    await telegram.replyText(chatId, message.message_id, finalText);
  } catch (err) {
    context.error(`Transcription failed: ${err.message}`);
    await safeReply(telegram, chatId, message.message_id, `⚠️ Transcription failed: ${err.message}`);
  }

  return { status: 200, body: 'ok' };
}

async function safeReply(telegram, chatId, messageId, text) {
  try {
    await telegram.replyText(chatId, messageId, text);
  } catch {
    /* nothing more we can do */
  }
}

app.http('transcribe', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'telegram',
  handler,
});
