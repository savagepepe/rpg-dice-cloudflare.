import {DurableObject} from 'cloudflare:workers';
import {commandResponse, freshState} from './game.js';

// Un Durable Object per chat: accesso serializzato e stato persistente in storage.
export class ChatDeck extends DurableObject {
  async fetch(request) {
    const payload=await request.json();
    if(payload.kind!=='command') return new Response('Bad request',{status:400});
    return this.ctx.blockConcurrencyWhile(async () => {
      const key=`update:${payload.updateId}`;
      if(await this.ctx.storage.get(key)) return Response.json({duplicate:true});
      const state=(await this.ctx.storage.get('deck'))||freshState();
      let result;
      try { result=commandResponse(payload.text,state); }
      catch(e) { result={text:`Errore: ${e.message}`,state}; }
      if(!result) return Response.json({ignored:true});
      await this.ctx.storage.put('deck',result.state);
      await this.ctx.storage.put(key,true);
      return Response.json({text:result.text});
    });
  }
}

async function telegramSend(env,chatId,text,threadId) {
  const payload={chat_id:chatId,text};
  if(threadId!==undefined) payload.message_thread_id=threadId;
  const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)
  });
  if(!response.ok) throw Error(`Telegram sendMessage HTTP ${response.status}`);
  const result=await response.json();
  if(!result.ok) throw Error('Telegram sendMessage non riuscito');
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/health') return new Response('OK');
    if(request.method!=='POST'||url.pathname!=='/telegram') return new Response('Not found',{status:404});
    if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET) return new Response('Configuration error',{status:500});
    if(request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
    let update;
    try {update=await request.json();} catch {return new Response('Bad JSON',{status:400});}
    const message=update.message;
    if(!message?.chat?.id||typeof message.text!=='string'||!message.text.startsWith('/')) return new Response('OK');
    const id=env.DECKS.idFromName(String(message.chat.id));
    const stub=env.DECKS.get(id);
    const response=await stub.fetch('https://internal/command',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({kind:'command',text:message.text,updateId:update.update_id})
    });
    if(!response.ok) return new Response('Internal error',{status:500});
    const result=await response.json();
    if(result.text) await telegramSend(env,message.chat.id,result.text,message.message_thread_id);
    return new Response('OK');
  }
};
