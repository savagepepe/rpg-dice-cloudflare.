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
      if (p.inspect !== true) return { sillyTavernOnline: r.ok, httpStatus: r.status };
      const checks = {};
      for (const path of ['/api/settings/get', '/api/worldinfo/list', '/api/characters/all']) {
        try {
          const h = await stHeaders();
          const res = await fetch(local + path, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
          const txt = await res.text();
          let keys = [];
          if (res.ok) {
            try {
              const data = JSON.parse(txt);
              if (data && typeof data === 'object' && !Array.isArray(data)) keys = Object.keys(data).filter(k => !/key|token|secret|password|credential|auth|cookie/i.test(k)).slice(0, 50);
            } catch {}
          }
          checks[path] = { httpStatus: res.status, responseBytes: txt.length, topLevelKeys: keys };
        } catch (e) { checks[path] = { error: e.message.slice(0, 100) }; }
      }
      if (p.details === true) {
        try {
          const h = await stHeaders();
          const res = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
          if (res.ok) {
            const data = await res.json();
            const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
            const safe = {};
            const allow = ['main_api', 'max_context', 'amount_gen', 'swipes', 'streaming', 'streaming_enabled', 'auto_save_msg_edits', 'auto_fix_generated_markdown', 'trim_spaces', 'collapse_newlines', 'power_user'];
            if (settings && typeof settings === 'object') {
              for (const key of allow) {
                const value = settings[key];
                if (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length < 80)) safe[key] = value;
              }
            }
            checks.configuration = { safeSettings: safe, availableThemes: Array.isArray(data.themes) ? data.themes.length : null, contextPresets: Array.isArray(data.context) ? data.context.length : null, instructPresets: Array.isArray(data.instruct) ? data.instruct.length : null, systemPrompts: Array.isArray(data.sysprompt) ? data.sysprompt.length : null };
          } else checks.configuration = { httpStatus: res.status };
        } catch (e) { checks.configuration = { error: e.message.slice(0, 100) }; }
      }
      if (p.configureGeneration && typeof p.configureGeneration === 'object') {
        const desired = p.configureGeneration;
        const permitted = { amount_gen: [100, 1500], max_context: [2048, 32768] };
        if (Object.keys(desired).length === 0 || Object.keys(desired).some(k => !Object.hasOwn(permitted, k))) throw new Error('Parametri non consentiti');
        for (const [key, value] of Object.entries(desired)) {
          const [min,max] = permitted[key];
          if (!Number.isInteger(value) || value < min || value > max) throw new Error('Valore non valido: ' + key);
        }
        const h = await stHeaders();
        const res = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) throw new Error('Lettura impostazioni HTTP ' + res.status);
        const responseData = await res.json();
        const original = typeof responseData.settings === 'string' ? JSON.parse(responseData.settings) : responseData.settings;
        if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('Formato impostazioni inatteso');
        const before = {};
        for (const key of Object.keys(desired)) {
          if (!Number.isInteger(original[key])) throw new Error('Campo assente: ' + key);
          before[key] = original[key];
        }
        if (p.dryRun !== false) {
          checks.generationPlan = { before, proposed: desired, applied: false };
        } else {
          const backupDir = new URL('../backups/', import.meta.url);
          fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
          const fileName = 'before-generation-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
          fs.writeFileSync(new URL(fileName, backupDir), JSON.stringify(original), { mode: 0o600, flag: 'wx' });
          const updated = { ...original, ...desired };
          const save = await fetch(local + '/api/settings/save', {
            method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
            body: JSON.stringify(updated)
          });
          if (!save.ok) throw new Error('Salvataggio HTTP ' + save.status);
          const checkHeaders = await stHeaders();
          const verify = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...checkHeaders, 'Content-Type': 'application/json' }, body: '{}' });
          if (!verify.ok) throw new Error('Verifica HTTP ' + verify.status);
          const afterResponse = await verify.json();
          const after = typeof afterResponse.settings === 'string' ? JSON.parse(afterResponse.settings) : afterResponse.settings;
          const verified = Object.entries(desired).every(([k,v]) => after[k] === v);
          checks.generationPlan = { before, proposed: desired, applied: verified, backupFile: fileName, localOnly: true };
          if (!verified) throw new Error('Impostazioni salvate ma verifica non riuscita');
        }
      }
      if (p.configureOpenRouter === true) {
        const h = await stHeaders();
        const res = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) throw new Error('Lettura impostazioni HTTP ' + res.status);
        const responseData = await res.json();
        const original = typeof responseData.settings === 'string' ? JSON.parse(responseData.settings) : responseData.settings;
        if (!original || typeof original !== 'object' || !original.oai_settings || typeof original.oai_settings !== 'object') throw new Error('Configurazione OpenRouter assente');
        const old = original.oai_settings;
        const before = { main_api: original.main_api, chat_completion_source: old.chat_completion_source, openrouter_model: old.openrouter_model };
        const chosenModel = p.freeModel === 'nemotron' ? 'nvidia/nemotron-3-ultra-550b-a55b:free' : 'openrouter/free';
        const proposed = { main_api: 'openai', chat_completion_source: 'openrouter', openrouter_model: chosenModel };
        if (p.dryRun !== false) {
          checks.openRouterPlan = { before, proposed, applied: false };
        } else {
          const backupDir = new URL('../backups/', import.meta.url);
          fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
          const fileName = 'before-openrouter-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
          fs.writeFileSync(new URL(fileName, backupDir), JSON.stringify(original), { mode: 0o600, flag: 'wx' });
          const updated = { ...original, main_api: 'openai', oai_settings: { ...old, chat_completion_source: 'openrouter', openrouter_model: chosenModel } };
          const save = await fetch(local + '/api/settings/save', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(updated) });
          if (!save.ok) throw new Error('Salvataggio HTTP ' + save.status);
          const vh = await stHeaders();
          const verify = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...vh, 'Content-Type': 'application/json' }, body: '{}' });
          if (!verify.ok) throw new Error('Verifica HTTP ' + verify.status);
          const data = await verify.json();
          const after = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
          const verified = after.main_api === 'openai' && after.oai_settings?.chat_completion_source === 'openrouter' && after.oai_settings?.openrouter_model === chosenModel;
          checks.openRouterPlan = { before, proposed, applied: verified, backupFile: fileName, localOnly: true };
          if (!verified) throw new Error('Verifica modello non riuscita');
        }
      }
      if (p.discoverModel === true) {
        try {
          const h = await stHeaders();
          const res = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const d = await res.json();
          const s = typeof d.settings === 'string' ? JSON.parse(d.settings) : d.settings;
          const o = typeof d.openai_settings === 'string' ? JSON.parse(d.openai_settings) : d.openai_settings;
          const safeModel = {};
          const inspect = (obj, prefix) => {
            if (!obj || typeof obj !== 'object') return;
            for (const [key, value] of Object.entries(obj)) {
              if (!/^(main_api|chat_completion_source|openai_model|claude_model|google_model|openrouter_model|custom_model|model|model_name|api_type|preset_settings_openai|preset_settings|temperature|top_p|max_context|amount_gen)$/i.test(key)) continue;
              if ((typeof value === 'string' && value.length <= 100) || typeof value === 'number' || typeof value === 'boolean') safeModel[prefix + key] = value;
            }
          };
          inspect(s, 'settings.');
          inspect(o, 'openai.');
          if (s && typeof s === 'object') {
            for (const key of ['oai_settings','openai_settings','chat_completion_settings']) inspect(s[key], 'settings.' + key + '.');
          }
          checks.modelDiscovery = safeModel;
        } catch (e) { checks.modelDiscovery = { error: e.message.slice(0,100) }; }
      }
      if (p.backup === true) {
        const h = await stHeaders();
        const res = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) throw new Error('Backup settings HTTP ' + res.status);
        const settingsData = await res.json();
        const backupDir = new URL('../backups/', import.meta.url);
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const fileName = 'settings-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        fs.writeFileSync(new URL(fileName, backupDir), JSON.stringify(settingsData), { mode: 0o600, flag: 'wx' });
        checks.backup = { created: true, file: fileName, location: 'local-only', bytes: Buffer.byteLength(JSON.stringify(settingsData)) };
      }
      if (p.model === true) {
        try {
          const h = await stHeaders();
          const res = await fetch(local + '/api/settings/get', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
          if (res.ok) {
            const data = await res.json();
            const s = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
            const o = typeof data.openai_settings === 'string' ? JSON.parse(data.openai_settings) : data.openai_settings;
            const modelFields = {};
            for (const [name, obj] of [['settings',s],['openai',o]]) {
              if (obj && typeof obj === 'object') {
                for (const key of ['chat_completion_source','openai_model','claude_model','google_model','openrouter_model','custom_model','max_context','amount_gen']) {
                  const v = obj[key];
                  if (typeof v === 'string' && v.length <= 100 || typeof v === 'number') modelFields[name + '.' + key] = v;
                }
              }
            }
            checks.model = modelFields;
          } else checks.model = { httpStatus: res.status };
        } catch (e) { checks.model = { error: e.message.slice(0,100) }; }
      }
      return { sillyTavernOnline: r.ok, httpStatus: r.status, diagnostics: checks };
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
console.log('RPG Manager avviato (configurazione controllata, backup, personaggi, Lorebook)');
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
