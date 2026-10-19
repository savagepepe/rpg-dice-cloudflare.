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
export function commandResponse(text, state, rng=Math.random) {
  const input=(text||'').trim(); const [raw,...args]=input.split(/\s+/);
  const command=(raw||'').split('@')[0].toLowerCase();
  if(command==='/start'||command==='/aiuto'||command==='/help') return {text:'Bot RPG: /d4 /d6 /d8 /d10 /d12 /d20; /dadi 1d20+5 1d6!; /iniziativa Alice Bob; /iniziativa riavvio. I dadi con ! esplodono. Jolly: reset del mazzo.',state};
  if(/^\/d(4|6|8|10|12|20)$/.test(command)) {
    const faces=command.slice(2); const expr=`1d${faces}! 1d6!`;
    return {text:formatRoll(rollExpression(expr,rng),`Macro: d${faces}\n${expr}`),state};
  }
  if(command==='/dadi') return {text:args.length?formatRoll(rollExpression(args.join(' '),rng),`Tiro: ${args.join(' ')}`):'Uso: /dadi 1d20+5 1d6!',state};
  if(command==='/pesca'||command==='/pesca*') {
    const result=drawCard(state,rng);
    return {...result, spoiler:command.endsWith('*')};
  }
  if(command==='/iniziativa'||command==='/iniziativa*') {
    if(!args.length) return {text:'Uso: /iniziativa Alice Bob Carlo; /iniziativa riavvio',state};
    if(args[0].toLowerCase()==='riavvio') return {text:'Iniziativa: mazzo usato azzerato.',state:freshState()};
    const result=drawInitiative(state,args,rng);
    return {text:`Iniziativa:\n${result.text}`,state:result.state,spoiler:command.endsWith('*')};
  }
  return null;
}
