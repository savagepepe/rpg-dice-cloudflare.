import { DurableObject } from 'cloudflare:workers';
import { commandResponse, freshState } from './game.js';

export class ChatDeck extends DurableObject {
  async fetch(request) {
    const payload = await request.json();
    if (payload.kind === 'register') {
      if (!payload.username || !payload.userId) return new Response('Bad request', {status:400});
      await this.ctx.storage.put('user:' + payload.username.toLowerCase(), payload.userId);
      return Response.json({ok:true});
    }
    if (payload.kind === 'lookup') {
      return Response.json({userId: await this.ctx.storage.get('user:' + payload.username.toLowerCase()) || null});
    }
    if (payload.kind === 'reveal') {
      return this.ctx.blockConcurrencyWhile(async () => {
        const key = 'initiative:' + payload.initiativeId;
        const session = await this.ctx.storage.get(key);
        if (!session || !Number.isInteger(payload.index) || payload.index < 0 || payload.index >= session.lines.length)
          return Response.json({error:'Iniziativa non disponibile'});
        session.revealed[payload.index] = true;
        await this.ctx.storage.put(key, session);
        return Response.json({text:renderInitiative(session),reply_markup:initiativeKeyboard(session,payload.initiativeId)});
      });
    }
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
      if (result.recipient) {
        if (!payload.recipientId) return Response.json({text:`@ ${result.recipient} deve aprire la chat privata con il bot e inviare /start prima di ricevere carte.`.replace('@ ', '@')});
        try {
          await telegramSend(this.env, payload.recipientId, result.text);
        } catch {
          return Response.json({text:'Non riesco a inviare la carta in privato. Il destinatario deve avviare il bot con /start. Nessuna carta è stata consumata.'});
        }
        result.text = `Carta inviata privatamente a @${result.recipient}.`;
      }
      if (result.initiativeButtons) {
        const initiativeId = String(payload.updateId);
        const session = {lines:result.text.split('\n').slice(1),revealed:[]};
        await this.ctx.storage.put('initiative:' + initiativeId, session);
        result.text = renderInitiative(session);
        result.reply_markup = initiativeKeyboard(session, initiativeId);
      }
      await this.ctx.storage.put('deck', result.state);
      await this.ctx.storage.put(key, true);
      return Response.json({ text: result.text, spoiler: Boolean(result.spoiler), individualSpoilers: Boolean(result.individualSpoilers), reply_markup: result.reply_markup || null });
    });
  }
}

function renderInitiative(session) {
  return '🃏 Iniziativa:\n' + session.lines.map((line,i) => session.revealed[i] ? line : (i+1) + '. 🂠 Carta nascosta').join('\n');
}
function initiativeKeyboard(session, id) {
  return {inline_keyboard:session.lines.map((line,i) => [{
    text:session.revealed[i] ? '✓ Carta ' + (i+1) + ' rivelata' : '🃏 Scopri carta ' + (i+1),
    callback_data:'ir:' + id + ':' + i
  }])};
}
async function telegramApi(env, method, payload) {
  const response=await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  const result=await response.json();
  if(!response.ok || !result.ok) throw new Error('Telegram ' + method + ' non riuscito');
  return result;
}
async function telegramSend(env, chatId, text, threadId, spoiler=false, individualSpoilers=false, replyMarkup=null) {
  const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const formatted = individualSpoilers
    ? text.split('\n').map((line, i) => {
        if (i === 0) return escapeHtml(line);
        const match = /^(\d+\.\s+.+?\s+[–-]\s+)(.+)$/.exec(line);
        return match ? '<tg-spoiler>' + escapeHtml(line) + '</tg-spoiler>' : escapeHtml(line);
      }).join('\n')
    : spoiler ? '<tg-spoiler>' + escapeHtml(text) + '</tg-spoiler>' : text;
  const payload = { chat_id: chatId, text: formatted };
  if (spoiler || individualSpoilers) payload.parse_mode = 'HTML';
  if (threadId !== undefined) payload.message_thread_id = threadId;
  if (replyMarkup) payload.reply_markup = replyMarkup;
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
  const contentType = request.headers.get('Content-Type') || '';
  let suppliedSecret = request.headers.get('X-Setup-Secret');
  if (!suppliedSecret && contentType.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    suppliedSecret = form.get('secret');
  }
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
        allowed_updates: ['message', 'callback_query']
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
    if (request.method === 'GET' && url.pathname === '/setup-webhook') {
      return new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Attiva pulsanti Telegram</title></head><body style="font:16px system-ui;max-width:420px;margin:40px auto;padding:16px"><h2>Attiva i pulsanti Telegram</h2><p>Inserisci il segreto TELEGRAM_WEBHOOK_SECRET di Cloudflare. Non inserire il token del bot.</p><form method="POST" action="/setup-webhook" autocomplete="off"><label>Segreto webhook<br><input type="password" name="secret" required autocomplete="off" style="width:100%;padding:12px;box-sizing:border-box;margin:12px 0"></label><button type="submit" style="padding:12px">Attiva pulsanti</button></form></body></html>`, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
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
    if (update.callback_query) {
      const cb=update.callback_query;
      const match=/^ir:(\\d+):(\\d+)$/.exec(cb.data || '');
      if (!match || !cb.message?.chat?.id) {
        await telegramApi(env,'answerCallbackQuery',{callback_query_id:cb.id});
        return new Response('OK');
      }
      const stub=env.DECKS.get(env.DECKS.idFromName(String(cb.message.chat.id)));
      const response=await stub.fetch('https://internal/reveal',{method:'POST',body:JSON.stringify({
        kind:'reveal',initiativeId:match[1],index:Number(match[2])
      })});
      const result=await response.json();
      await telegramApi(env,'answerCallbackQuery',{callback_query_id:cb.id,text:result.error || 'Carta rivelata'});
      if (!result.error) await telegramApi(env,'editMessageText',{
        chat_id:cb.message.chat.id,message_id:cb.message.message_id,
        text:result.text,reply_markup:result.reply_markup
      });
      return new Response('OK');
    }
    const message = update.message;
    if (!message?.chat?.id || typeof message.text !== 'string' || !message.text.startsWith('/')) {
      return new Response('OK');
    }
    const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    const registry = env.DECKS.get(env.DECKS.idFromName('telegram-user-registry'));
    if (message.chat.type === 'private' && command === '/start') {
      if (message.from?.username) {
        await registry.fetch('https://internal/register', {method:'POST', body:JSON.stringify({
          kind:'register', username:message.from.username, userId:message.from.id
        })});
      }
      await telegramSend(env, message.chat.id, message.from?.username
        ? 'Registrazione completata. Ora puoi ricevere carte private tramite /pesca @' + message.from.username + ' nei gruppi.'
        : 'Per ricevere carte private devi impostare un username Telegram e poi inviare di nuovo /start.');
      return new Response('OK');
    }
    let recipientId;
    const recipientMatch = /^\/pesca(?:@\w+)?\s+@([a-zA-Z0-9_]{5,32})\s*$/i.exec(message.text.trim());
    if (recipientMatch) {
      const lookup = await registry.fetch('https://internal/lookup', {method:'POST', body:JSON.stringify({
        kind:'lookup', username:recipientMatch[1]
      })});
      recipientId = (await lookup.json()).userId;
    }
    const id = env.DECKS.idFromName(String(message.chat.id));
    const stub = env.DECKS.get(id);
    const response = await stub.fetch('https://internal/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'command',
        text: message.text,
        updateId: update.update_id,
        recipientId
      })
    });
    if (!response.ok) return new Response('Internal error', { status: 500 });
    const result = await response.json();
    if (result.text) {
      await telegramSend(env, message.chat.id, result.text, message.message_thread_id, result.spoiler, result.individualSpoilers, result.reply_markup);
    }
    return new Response('OK');
  }
};
