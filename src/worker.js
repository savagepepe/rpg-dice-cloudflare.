import { DurableObject } from 'cloudflare:workers';
import { commandResponse, freshState } from './game.js';

export class ChatDeck extends DurableObject {
  async fetch(request) {
    const payload = await request.json();
    if (payload.kind !== 'command') return new Response('Bad request', { status: 400 });
    return this.ctx.blockConcurrencyWhile(async () => {
      const key = `update:${payload.updateId}`;
      if (await this.ctx.storage.get(key)) return Response.json({ duplicate: true });
      const state = (await this.ctx.storage.get('deck')) || freshState();
      let result;
      try {
        result = commandResponse(payload.text, state);
      } catch (error) {
        result = { text: `Errore: ${error.message}`, state };
      }
      if (!result) return Response.json({ ignored: true });
      await this.ctx.storage.put('deck', result.state);
      await this.ctx.storage.put(key, true);
      return Response.json({ text: result.text, spoiler: Boolean(result.spoiler) });
    });
  }
}

async function telegramSend(env, chatId, text, threadId, spoiler=false) {
  const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const payload = { chat_id: chatId, text: spoiler ? `<tg-spoiler>${escapeHtml(text)}</tg-spoiler>` : text };
  if (spoiler) payload.parse_mode = 'HTML';
  if (threadId !== undefined) payload.message_thread_id = threadId;
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) throw new Error(`Telegram sendMessage HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error('Invio del messaggio non riuscito');
}

async function setupWebhook(request, env, url) {
  const suppliedSecret = request.headers.get('X-Setup-Secret');
  if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.TELEGRAM_BOT_TOKEN) return new Response('Token Telegram mancante', { status: 500 });
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message']
      })
    }
  );
  const result = await response.json();
  return Response.json(
    { ok: result.ok, description: result.description },
    { status: result.ok ? 200 : 502 }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK');
    }
    if (request.method === 'POST' && url.pathname === '/setup-webhook') {
      return setupWebhook(request, env, url);
    }
    if (request.method !== 'POST' || url.pathname !== '/telegram') {
      return new Response('Not found', { status: 404 });
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Configuration error', { status: 500 });
    }
    const suppliedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }
    const message = update.message;
    if (!message?.chat?.id || typeof message.text !== 'string' || !message.text.startsWith('/')) {
      return new Response('OK');
    }
    const id = env.DECKS.idFromName(String(message.chat.id));
    const stub = env.DECKS.get(id);
    const response = await stub.fetch('https://internal/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'command',
        text: message.text,
        updateId: update.update_id
      })
    });
    if (!response.ok) return new Response('Internal error', { status: 500 });
    const result = await response.json();
    if (result.text) {
      await telegramSend(env, message.chat.id, result.text, message.message_thread_id, result.spoiler);
    }
    return new Response('OK');
  }
};
