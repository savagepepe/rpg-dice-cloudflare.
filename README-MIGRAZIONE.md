# Migrazione Cloudflare – RPG Dice Telegram Bot

Questi file si aggiungono al repository originale. **Non sostituire `main.py`**: resta la versione Python precedente. La versione Cloudflare è una porta JavaScript delle stesse regole, perché Workers + Durable Objects JavaScript è una soluzione consolidata e non richiede adattare `python-telegram-bot` al runtime serverless.

## Prerequisiti
- Account Cloudflare con Workers abilitati
- Node.js recente e npm
- Token del bot da BotFather
- Il bot originale in polling deve essere arrestato al momento del passaggio a webhook.

## Installazione
1. Copia `src/`, `test/`, `package.json`, `wrangler.jsonc` e `.gitignore` nella radice del repository (non sovrascrivere file preesistenti senza confrontarli).
2. Esegui `npm install` e `npm test`.
3. Esegui `npx wrangler login`.
4. Esegui `npx wrangler secret put TELEGRAM_BOT_TOKEN` e incolla il token del bot.
5. Genera un segreto casuale di almeno 32 caratteri con lettere, numeri, `_` o `-`, e impostalo con `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
6. Esegui `npm run deploy`. Annota l'URL pubblico `https://<nome>.<account>.workers.dev`.
7. **Ferma il vecchio bot in polling**. Poi registra il webhook (sostituisci le variabili localmente, senza committare il token):

```bash
export TELEGRAM_BOT_TOKEN='INSERISCI_TOKEN'
export TELEGRAM_WEBHOOK_SECRET='INSERISCI_STESSO_SEGRETO'
export WORKER_URL='https://<nome>.<account>.workers.dev'
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{\"url\":\"%s/telegram\",\"secret_token\":\"%s\",\"allowed_updates\":[\"message\"]}' "$WORKER_URL" "$TELEGRAM_WEBHOOK_SECRET")"
```

8. Verifica `getWebhookInfo` e prova `/start`, `/d8`, `/dadi 1d20+5 1d6!`, `/iniziativa Alice Bob` in due chat differenti.

## Dettagli operativi
- Ogni chat ha un Durable Object distinto, con mazzo in storage persistente.
- La prima estrazione dopo il deploy parte da un mazzo nuovo. **Non importa lo stato RAM del vecchio bot.**
- Se compare un jolly, il mazzo viene resettato come nella versione originale.
- Il worker accetta soltanto richieste webhook con l'header segreto.
- `GET /health` restituisce OK.
- Le quote del piano gratuito Cloudflare non garantiscono uptime assoluto.
- Attenzione: l'invio di Telegram avviene dopo il salvataggio dello stato. In caso di errore nell'invio del messaggio, un retry può essere considerato duplicato; per garanzie più forti serve una outbox persistente.
- Non impostare contemporaneamente webhook e polling.

## Rollback
Rimuovi il webhook con `deleteWebhook`, poi riavvia il programma Python originale. Il mazzo Cloudflare non viene trasferito automaticamente alla RAM Python.

## Sicurezza
Non inserire token in GitHub, nei log o nelle issue. Se un token è stato esposto, revocalo tramite BotFather.
