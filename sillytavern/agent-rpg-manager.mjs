import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const worker = String(config.workerUrl || '').replace(/\/$/, '');
const token = config.agentToken;
const local = 'http://127.0.0.1:8000';
if (!worker.startsWith('https://') || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Configurazione non valida');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cloud(path, data) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(worker + path, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
    if (!response.ok) throw new Error('Cloudflare HTTP ' + response.status);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
async function stHeaders() {
  const response = await fetch(local + '/csrf-token');
  if (!response.ok) throw new Error('SillyTavern CSRF HTTP ' + response.status);
  const { token: csrf } = await response.json();
  if (!csrf) throw new Error('CSRF token mancante');
  const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return { 'X-CSRF-Token': csrf, Cookie: cookies };
}
async function stPost(path, data, form = false) {
  const headers = await stHeaders();
  headers['Content-Type'] = form ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'application/json';
  const response = await fetch(local + path, {
    method: 'POST', headers,
    body: form ? new URLSearchParams(data).toString() : JSON.stringify(data)
  });
  const body = await response.text();
  if (!response.ok) throw new Error('SillyTavern HTTP ' + response.status + ': ' + body.slice(0, 200));
  try { return JSON.parse(body); } catch { return body.slice(0, 500); }
}
const stringField = (value, label, max = 12000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Campo ' + label + ' non valido');
  return value;
};
const safeName = (value, label) => {
  const s = stringField(value, label, 120).trim();
  if (!s || /[\\/\x00-\x1f]/.test(s) || s === '.' || s === '..') throw new Error(label + ' non valido');
  return s;
};
async function execute(job) {
  if (!job || typeof job !== 'object') throw new Error('Comando non valido');
  const p = job.payload || {};
  switch (job.type) {
    case 'health': {
      const r = await fetch(local + '/');
      return { sillyTavernOnline: r.ok, httpStatus: r.status };
    }
    case 'create_character': {
      const name = safeName(p.name, 'name');
      const form = {
        ch_name: name,
        description: stringField(p.description || '', 'description'),
        personality: stringField(p.personality || '', 'personality'),
        scenario: stringField(p.scenario || '', 'scenario'),
        first_mes: stringField(p.first_mes || '', 'first_mes'),
        mes_example: stringField(p.mes_example || '', 'mes_example'),
        creator_notes: stringField(p.creator_notes || '', 'creator_notes'),
        tags: JSON.stringify(Array.isArray(p.tags) ? p.tags.filter(x => typeof x === 'string').slice(0, 20) : []),
        world: p.world ? safeName(p.world, 'world') : ''
      };
      const result = await stPost('/api/characters/create', form, true);
      return { action: 'create_character', name, result };
    }
    case 'upsert_lorebook': {
      const name = safeName(p.name, 'name');
      if (!p.data || typeof p.data !== 'object' || Array.isArray(p.data)) throw new Error('Lorebook data non valido');
      if (JSON.stringify(p.data).length > 80000) throw new Error('Lorebook troppo grande');
      const result = await stPost('/api/worldinfo/edit', { name, data: p.data });
      return { action: 'upsert_lorebook', name, result };
    }
    default: throw new Error('Operazione non autorizzata');
  }
}
console.log('RPG Manager avviato (health, create_character, upsert_lorebook)');
while (true) {
  try {
    const job = await cloud('/agent/claim', {});
    if (job.id) {
      console.log('Comando ricevuto:', job.type);
      let ok = true, result;
      try { result = await execute(job); }
      catch (e) { ok = false; result = { error: e.message }; }
      await cloud('/agent/complete/' + job.id, { ok, result });
      console.log('Comando completato:', ok ? 'OK' : 'ERRORE');
    }
  } catch (e) { console.error('Connessione:', e.message); }
  await sleep(5000);
}
