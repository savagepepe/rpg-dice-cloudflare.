// Porting delle regole di main.py. Nessuna dipendenza da Telegram o Cloudflare.
const SUITS = [['♠️', 0], ['♣️', 1], ['♦️', 2], ['♥️', 3]];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const MAX_DICE = 100, MAX_FACES = 10000, MAX_EXPLOSIONS = 100;
export const fullDeck = () => [
  ...VALUES.flatMap(value => SUITS.map(([suit]) => ({id:`${value}:${suit}`, value, suit}))),
  {id:'joker:1', value:'Jolly', suit:'🃏'}, {id:'joker:2', value:'Jolly', suit:'🃏'}
];
export const freshState = () => ({used:[]});
export function rollDie(faces, explode, rng = Math.random) {
  if (!Number.isSafeInteger(faces) || faces < 2 || faces > MAX_FACES) throw Error('Numero di facce non valido (2–10000).');
  const rolls=[];
  for(let i=0;i<(explode?MAX_EXPLOSIONS:1);i++) {
    const value = Math.floor(rng()*faces)+1;
    rolls.push(value);
    if(!explode || value!==faces) return rolls;
  }
  throw Error('Troppe esplosioni consecutive.');
}
export function rollExpression(expression, rng = Math.random) {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length>2) throw Error('Inserisci uno o due dadi, es. 1d8! 1d6!.');
  return parts.map(raw => {
    const match=/^(\d+)?d(\d+)([+-]\d+)?(!)?$/i.exec(raw);
    if(!match) throw Error(`Espressione non valida: ${raw}`);
    const qty=Number(match[1]||1), faces=Number(match[2]), mod=Number(match[3]||0), explode=Boolean(match[4]);
    if(!Number.isSafeInteger(qty)||qty<1||qty>MAX_DICE) throw Error('Quantità di dadi non valida (1–100).');
    if(!Number.isSafeInteger(mod)||Math.abs(mod)>1000000) throw Error('Modificatore troppo grande.');
    const details=Array.from({length:qty},()=>{const rolls=rollDie(faces,explode,rng);return {rolls, subtotal:rolls.reduce((a,b)=>a+b,0)};});
    return {raw,qty,faces,mod,explode,details,total:details.reduce((a,d)=>a+d.subtotal,mod),first:details[0].rolls[0]};
  });
}
export function formatRoll(results, heading='') {
  const lines=heading?[heading,'']:[];
  results.forEach((r,index)=>{
    lines.push(`${index===0?'Dado Tiro': 'Dado Fortuna'} (${r.raw}):`);
    r.details.forEach((d,i)=>lines.push(`  Dado ${i+1}: [${d.rolls.join(', ')}] = ${d.subtotal}${r.explode&&d.rolls.length>1?' (esplode) 🎉':r.first===1?' (1) ❌':''}`));
    if(r.mod) lines.push(`  Modificatore: ${r.mod>0?'+':''}${r.mod}`);
    lines.push(`  Totale ${index===0?'tiro':'fortuna'}: ${r.total}${r.first===1?' (1) ❌':r.explode&&r.details.some(d=>d.rolls.length>1)?' (esplode) 🎉':''}`,'');
  });
  if(results.length===2&&results.every(r=>r.first===1)) lines.push('🔴 FALLIMENTO CRITICO 🔴');
  return lines.join('\n').trim();
}
const rank=value=>value==='Jolly'?100:value==='A'?14:value==='K'?13:value==='Q'?12:value==='J'?11:Number(value);
const suitRank=suit=>SUITS.find(([s])=>s===suit)?.[1]??0;
export function drawInitiative(state, names, rng=Math.random) {
  if(!Array.isArray(names)||!names.length||names.length>54) throw Error('Indica da 1 a 54 partecipanti.');
  let used = new Set(state?.used || []);
  let available=fullDeck().filter(c=>!used.has(c.id));
  if(available.length<names.length) {used=new Set(); available=fullDeck();}
  // Fisher-Yates per selezione senza reinserimento
  for(let i=available.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[available[i],available[j]]=[available[j],available[i]];}
  const cards=available.slice(0,names.length);
  for(const card of cards) used.add(card.id);
  if(cards.some(c=>c.value==='Jolly')) used=new Set();
  const rows=names.map((name,i)=>({name,...cards[i]})).sort((a,b)=>rank(b.value)-rank(a.value)||suitRank(b.suit)-suitRank(a.suit));
  return {state:{used:[...used]}, text:rows.map((r,i)=>`${i+1}. ${r.name} – ${r.value} ${r.suit}`).join('\n'),cards};
}
export function drawCard(state, rng=Math.random) {
  const result=drawInitiative(state,['Carta'],rng);
  const card=result.cards[0];
  return {state:result.state, text:`Carta pescata: ${card.value} ${card.suit}`};
}
export function rollDamage(expression, rng = Math.random) {
  const input = expression.replace(/\s+/g, '');
  if (!input) throw Error('Uso: /danno 1d4-1+1d6');
  const terms = input.match(/[+-]?[^+-]+/g) || [];
  if (terms.join('') !== input) throw Error('Espressione di danno non valida.');
  let total = 0, count = 0;
  const lines = ['⚔️ Danno: ' + input, ''];
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1;
    const raw = term.replace(/^[+-]/, '');
    const dice = /^(\d*)d(\d+)!?$/i.exec(raw);
    if (dice) {
      const qty = Number(dice[1] || 1), faces = Number(dice[2]);
      if (!Number.isSafeInteger(qty) || qty < 1 || count + qty > MAX_DICE)
        throw Error('Quantità totale di dadi non valida (1–100).');
      count += qty;
      for (let i = 0; i < qty; i++) {
        const rolls = rollDie(faces, true, rng);
        const subtotal = rolls.reduce((a,b) => a+b, 0);
        total += sign * subtotal;
        lines.push((sign < 0 ? '−' : '') + 'd' + faces + ': [' + rolls.join(' + ') + '] = ' + (sign * subtotal) + (rolls.length > 1 ? ' 💥 Esplode!' : ''));
      }
    } else if (/^\d+$/.test(raw)) {
      const modifier = Number(raw);
      if (!Number.isSafeInteger(modifier) || modifier > 1000000) throw Error('Modificatore troppo grande.');
      total += sign * modifier;
      lines.push('Modificatore: ' + (sign < 0 ? '−' : '+') + modifier);
    } else throw Error('Termine non valido: ' + term);
  }
  if (!count) throw Error('Inserisci almeno un dado.');
  lines.push('', '🎯 Danno totale: ' + total);
  return lines.join('\n');
}

export function commandResponse(text, state, rng=Math.random) {
  const input=(text||'').trim(); const [raw,...args]=input.split(/\s+/);
  const command=(raw||'').split('@')[0].toLowerCase();
  if(command==='/start'||command==='/aiuto'||command==='/help') return {text:`🎲 GUIDA BOT RPG

🎲 DADI RAPIDI
/d4 /d6 /d8 /d10 /d12 /d20
Puoi aggiungere il nome dell'abilità, per esempio /d6 atletica o /d8 percezione visiva.\nOgni comando tira il dado indicato (Dado Tiro) e un d6 (Dado Fortuna). Entrambi sono esplosivi: se esce il valore massimo, il dado viene rilanciato e i risultati si sommano.

⚔️ DANNI SAVAGE WORLDS
/danno 1d4-1+1d6
/danni 2d6+2
I comandi /danno e /danni sono equivalenti.\nTutti i dadi del danno esplodono automaticamente e si sommano, senza Dado Fortuna. Il simbolo ! è facoltativo.

🎯 DADI PERSONALIZZATI
/dadi 1d20+5
/dadi 2d8!
/dadi 1d8! 1d6!\n/dado 1d8! 1d6! atletica\n/dadi 1d8! 1d6! tiro per colpire\nI comandi /dadi e /dado sono equivalenti. Puoi aggiungere una descrizione dopo i dadi.\nSintassi: NdF+M oppure NdF-M, dove N è il numero di dadi, F le facce, M il modificatore. Il simbolo ! attiva l'esplosione. Puoi inserire una o due espressioni: la prima è il Dado Tiro, la seconda il Dado Fortuna. Se entrambi mostrano 1 al primo lancio, viene segnalato il fallimento critico.

🃏 PESCA CARTE
/pesca — pesca una carta e la mostra nel gruppo.
/pesca* — pesca una carta nascosta da spoiler: toccala per scoprirla.
/pesca @username — invia una carta in privato all'utente indicato, senza mostrarla nel gruppo. Il destinatario deve prima aprire la chat privata del bot e inviare /start, avendo un username Telegram.

⚔️ INIZIATIVA
/iniziativa Marco Luca Anna
Pesca una carta per ogni partecipante e mostra la classifica ordinata per valore.
/iniziativa* Marco Luca Anna
Crea un unico messaggio con nomi e carte inizialmente nascosti. Premi «Scopri carta» per rivelare una singola voce; le altre restano nascoste. Le carte rivelate sono visibili a tutti nel gruppo.
/iniziativa riavvio — azzera manualmente il mazzo del gruppo.

📚 REGOLE DEL MAZZO
54 carte (52 carte normali + 2 Jolly). Le carte estratte non tornano nel mazzo finché non viene azzerato. Il mazzo si azzera automaticamente quando esce un Jolly o quando non ci sono abbastanza carte per una nuova iniziativa. Ogni chat ha un mazzo indipendente e persistente.

ℹ️ /aiuto e /help mostrano questa guida. In chat privata /start serve anche per registrarsi alla pesca privata.`,state};
  if(/^\/d(4|6|8|10|12|20)$/.test(command)) {
    const faces=command.slice(2); const expr=`1d${faces}! 1d6!`;
    return {text:formatRoll(rollExpression(expr,rng),`Macro: d${faces}${args.length?' — '+args.join(' '):''}\n${expr}`),state};
  }
  if(command==='/danno'||command==='/danni') return {text:rollDamage(args.join(' '),rng),state};
  if(command==='/dadi'||command==='/dado') {
    if(!args.length) return {text:'Uso: /dadi 1d20+5 1d6! atletica',state};
    const dicePattern=/^(\\d+)?d\\d+([+-]\\d+)?!?$/i;
    const diceParts=[];
    while(diceParts.length<2 && args.length>diceParts.length && dicePattern.test(args[diceParts.length])) {
      diceParts.push(args[diceParts.length]);
    }
    if(!diceParts.length) throw Error('Inserisci un dado valido, es. /dadi 1d8! 1d6! atletica.');
    const description=args.slice(diceParts.length).join(' ');
    const expr=diceParts.join(' ');
    return {text:formatRoll(rollExpression(expr,rng),`Tiro: ${expr}${description?' — '+description:''}`),state};
  }
  if(command==='/pesca' && args.length && /^@[a-zA-Z0-9_]{5,32}$/.test(args[0])) {
    const result=drawCard(state,rng);
    return {...result, recipient:args[0].slice(1).toLowerCase()};
  }
  if(command==='/pesca'||command==='/pesca*') {
    const result=drawCard(state,rng);
    return {...result, spoiler:command.endsWith('*')};
  }
  if(command==='/iniziativa'||command==='/iniziativa*') {
    if(!args.length) return {text:'Uso: /iniziativa Alice Bob Carlo; /iniziativa riavvio',state};
    if(args[0].toLowerCase()==='riavvio') return {text:'Iniziativa: mazzo usato azzerato.',state:freshState()};
    const result=drawInitiative(state,args,rng);
    return {text:`Iniziativa:\n${result.text}`,state:result.state,spoiler:false,initiativeButtons:command.endsWith('*')};
  }
  return null;
}
