const API_BASE = 'https://api.telegram.org';

// Telegram caps a single text message at 4096 characters.
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Extracts the transcribable media (if any) from a Telegram message.
 * Handles voice bubbles, video notes (round messages), audio files, and
 * audio sent as a document.
 *
 * @returns {{fileId: string, kind: string, mimeType?: string} | null}
 */
export function extractMedia(message) {
  if (!message) return null;

  if (message.voice) {
    return { fileId: message.voice.file_id, kind: 'voice', mimeType: message.voice.mime_type };
  }
  if (message.video_note) {
    // Video notes have no mime_type field; they are mp4 containers.
    return { fileId: message.video_note.file_id, kind: 'video_note', mimeType: 'video/mp4' };
  }
  if (message.audio) {
    return { fileId: message.audio.file_id, kind: 'audio', mimeType: message.audio.mime_type };
  }
  if (message.video) {
    return { fileId: message.video.file_id, kind: 'video', mimeType: message.video.mime_type };
  }
  if (message.document && (message.document.mime_type || '').match(/^(audio|video)\//)) {
    return { fileId: message.document.file_id, kind: 'document', mimeType: message.document.mime_type };
  }
  return null;
}

export class TelegramClient {
  constructor(botToken) {
    this.botToken = botToken;
  }

  async #call(method, body) {
    const res = await fetch(`${API_BASE}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram ${method} failed: ${data.error_code} ${data.description}`);
    }
    return data.result;
  }

  async sendChatAction(chatId, action) {
    // Best-effort "typing"/"record" indicator; ignore failures.
    try {
      await this.#call('sendChatAction', { chat_id: chatId, action });
    } catch {
      /* non-fatal */
    }
  }

  /** Sends text, replying to the original message, splitting long transcripts. */
  async replyText(chatId, replyToMessageId, text) {
    const chunks = splitText(text || '(empty transcription)', MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      await this.#call('sendMessage', {
        chat_id: chatId,
        text: chunks[i],
        // Only reply-anchor the first chunk.
        ...(i === 0 ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      });
    }
  }

  /**
   * Downloads a file by file_id. Returns { bytes, filename, contentType }.
   * Note: the Bot API only serves files up to 20 MB.
   */
  async downloadFile(fileId, fallbackMime) {
    const file = await this.#call('getFile', { file_id: fileId });
    if (!file.file_path) {
      throw new Error('Telegram returned no file_path (file may exceed the 20 MB Bot API limit).');
    }
    const url = `${API_BASE}/file/bot${this.botToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download file: HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const filename = file.file_path.split('/').pop() || 'audio';
    const contentType = res.headers.get('content-type') || fallbackMime || 'application/octet-stream';
    return { bytes, filename, contentType };
  }
}

function splitText(text, max) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer to break on a newline near the limit, fall back to a hard cut.
    let cut = remaining.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  chunks.push(remaining);
  return chunks;
}
