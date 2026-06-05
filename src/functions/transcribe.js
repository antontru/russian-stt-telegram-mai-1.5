import { app } from '@azure/functions';
import { getConfig, getKeyterms } from '../config.js';
import { TelegramClient, extractMedia } from '../telegram.js';
import { transcribe } from '../elevenlabs.js';

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

    const { bytes, filename, contentType } = await telegram.downloadFile(media.fileId, media.mimeType);

    const { text, languageCode } = await transcribe({
      apiKey: config.elevenLabsApiKey,
      bytes,
      filename,
      contentType,
      model: config.model,
      languageCode: config.languageCode,
      keyterms: getKeyterms(),
    });

    context.log(`Transcribed ${media.kind} (${bytes.length} bytes, lang=${languageCode ?? 'auto'}).`);
    await telegram.replyText(chatId, message.message_id, text);
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
