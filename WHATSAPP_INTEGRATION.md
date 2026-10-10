# WhatsApp Integration — Reference & Porting Guide

How Citizen Desk sends and receives WhatsApp messages, and how to reuse that integration in another Node.js application.

---

## 1. Overview

The integration has three layers:

```
             ┌─────────────────────────── INBOUND ───────────────────────────┐
WhatsApp ──► Provider (WASender / Meta) ──► POST /api/webhook
                                              │ 1. ack 200 immediately
                                              │ 2. parse provider payload → normalized job
                                              │ 3. dedupe   (Redis SET NX  wa:msg:<id>, 24h)
                                              │ 4. buffer   (Redis RPUSH   wa:buffer:<phone>)
                                              │ 5. enqueue  (BullMQ, 3s delay = debounce)
                                              ▼
                                      dialog worker
                                              │ lock      (Redis SET NX lock:dialog:<phone>, 30s)
                                              │ drain     (RENAME buffer → temp, LRANGE, DEL)
                                              │ merge texts, take last image
                                              │ business logic (AI, state machine…)
                                              ▼
             └──────────── OUTBOUND ─────── sendWhatsAppMessage(phone, text) ──► Provider
```

| Layer | File | Responsibility |
|---|---|---|
| Provider facade | [backend/src/modules/whatsapp/whatsapp.service.js](../backend/src/modules/whatsapp/whatsapp.service.js) | Picks a provider from `WHATSAPP_MODE`; exposes `sendWhatsAppMessage` and `downloadWhatsAppMedia` |
| Providers | `whatsapp.wasender.js`, `whatsapp.cloud.js`, `whatsapp.mock.js` | Same interface: `sendMessage(phone, text)`, `downloadMedia(mediaId)` |
| Media decrypt | [backend/src/utils/whatsappMediaDecrypt.js](../backend/src/utils/whatsappMediaDecrypt.js) | Decrypts raw WhatsApp CDN media (WASender passes encrypted URLs) |
| Webhook | [backend/src/modules/webhook/](../backend/src/modules/webhook/) | Verification handshake, signature check, parsing, dedupe, buffering |
| Phone normalizer | [backend/src/utils/phoneNormalizer.js](../backend/src/utils/phoneNormalizer.js) | Converts any input to E.164, rejects group/broadcast JIDs |
| Templates | [backend/src/modules/whatsapp/whatsapp.templates.js](../backend/src/modules/whatsapp/whatsapp.templates.js) | Urdu / English / bilingual message strings with `{var}` interpolation |
| Consumer | [backend/src/modules/dialog/dialog.worker.js](../backend/src/modules/dialog/dialog.worker.js) | Locks per phone, drains the buffer, replies |

**Production currently runs `WHATSAPP_MODE=wasender`.**

---

## 2. Dependencies

```bash
npm install axios express bullmq ioredis zod
```

- Node.js **≥ 15** (uses `crypto.hkdfSync`)
- Redis (deduplication, buffering, locking, BullMQ)

---

## 3. Configuration

| Variable | Used by | Description |
|---|---|---|
| `WHATSAPP_MODE` | all | `mock` (default) \| `wasender` \| `cloud` |
| `WHATSAPP_ACCESS_TOKEN` | wasender, cloud | WASender API key **or** Meta permanent access token (sent as `Bearer`) |
| `WHATSAPP_PHONE_NUMBER_ID` | cloud | Meta phone-number ID used in the Graph URL |
| `WHATSAPP_VERIFY_TOKEN` | cloud | Must match the token entered in the Meta webhook settings |
| `WHATSAPP_APP_SECRET` | cloud | Meta app secret, used for HMAC `x-hub-signature-256` validation |
| `WHATSAPP_MOCK_NUMBER` | mock | Default number for the dev simulator |
| `UPLOAD_DIR` | mock | Mock media is read from `<UPLOAD_DIR>/mock-uploads/` |
| `SYSTEM_LANGUAGE` | templates | `urdu` \| `english` \| `bilingual` |

Schema (zod) lives in [backend/src/config/env.js](../backend/src/config/env.js); startup fails if `WHATSAPP_MODE=cloud` without an access token.

---

## 4. Providers

All providers implement:

```js
sendMessage(phone: string, text: string) => Promise<object>
downloadMedia(mediaId: string)          => Promise<{ buffer: Buffer, mimeType: string }>
```

### 4.1 WASender (`whatsapp.wasender.js`) — live

**Send**

```http
POST https://wasenderapi.com/api/send-message
Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>
Content-Type: application/json

{ "to": "+923001234567", "text": "Hello" }
```

- `to` is E.164 **with** the leading `+`.
- On HTTP **429** it waits 2 s and retries, up to 3 times. Other errors are logged and re-thrown.

**Download media.** `mediaId` is an overloaded string, produced by the webhook (§5.2). It is resolved in this order:

1. **JSON string containing `mediaKey`**: `{"url","mediaKey","mimetype","thumbnail"}`. The encrypted CDN file is downloaded and decrypted to full resolution. If decryption fails, the base64 `thumbnail` is returned instead.
2. **`data:` URL**: base64 decoded inline (the thumbnail-only case).
3. **`http…` URL**: plain GET with the bearer token.
4. **Anything else**: `GET https://wasenderapi.com/api/media/<id>`.

### 4.2 Meta Cloud API (`whatsapp.cloud.js`)

**Send**

```http
POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages
Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>

{ "messaging_product": "whatsapp", "to": "<phone>", "type": "text", "text": { "body": "<text>" } }
```

**Download media** takes two steps:
1. `GET https://graph.facebook.com/v21.0/<mediaId>` returns `{ url, mime_type }`
2. `GET <url>` with the bearer token returns the binary

> Cloud API only allows free-form text within 24 h of the user's last message. Outside that window you must send an approved template message. That isn't implemented here.

### 4.3 Mock (`whatsapp.mock.js`)

- `sendMessage` pretty-prints to the console and returns a Cloud-API-shaped response with an id like `mock_<ts>_<rand>`.
- `downloadMedia` reads `<UPLOAD_DIR>/mock-uploads/<mediaId>`. If the file is missing, it falls back to a 1×1 JPEG so downstream image/AI code doesn't crash.
- In `NODE_ENV=development`, signature validation is bypassed, and the simulator routes (`/api/dev/*`) and the `WhatsAppSimulator.jsx` frontend let you test without a phone.

---

## 5. Inbound Webhook

Routes ([webhook.routes.js](../backend/src/modules/webhook/webhook.routes.js)), mounted under `/api`:

| Method | Path | Handler |
|---|---|---|
| GET | `/api/webhook` | `verifyWebhook` |
| POST | `/api/webhook` | `receiveWebhook` |

Point the provider's webhook URL at `https://<your-domain>/api/webhook`.

### 5.1 Raw body capture (required for Meta HMAC)

```js
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
```

This must run **before** any other JSON parser. HMAC is computed over the exact raw bytes.

### 5.2 WASender payload → normalized job

Only `event === "messages.received"` is processed. All other events (status updates etc.) are ignored.

| Normalized field | Source in `req.body.data.messages` |
|---|---|
| `waMessageId` | `key.id` ‖ `id` |
| `text` | `message.conversation` ‖ `messageBody` ‖ `message.extendedTextMessage.text` |
| `contactName` | `pushName` |
| `phone` | `normalizePhone(key.cleanedSenderPn ‖ key.senderPn ‖ remoteJid)` |
| `messageType` | `'image'` if `message.imageMessage` exists, otherwise `'text'` |
| `imageId` | see below |

`imageId` for images, in priority order:
1. `url` + `mediaKey` present: `JSON.stringify({ url, mediaKey, mimetype, thumbnail: jpegThumbnail })`
2. only `jpegThumbnail`: `data:<mime>;base64,<thumb>`
3. only `url`: the URL
4. otherwise: `waMessageId`

### 5.3 Meta Cloud payload → normalized job

1. Validate `x-hub-signature-256` against `HMAC-SHA256(WHATSAPP_APP_SECRET, rawBody)` using `crypto.timingSafeEqual`.
2. `req.body.entry[0].changes[0].value.messages[0]`. If there are no `messages`, it's a status update, so skip it.
3. Mapping: `id → waMessageId`, `from → phone`, `type → messageType`, `text.body → text`, `image.id → imageId`, `value.contacts[0].profile.name → contactName`.

### 5.4 Normalized job shape

```js
{
  waMessageId: 'ABCD1234',
  phone: '+923001234567',
  messageType: 'text' | 'image' | 'document' | 'audio',
  text: 'string | null',
  imageId: 'string | null',   // pass straight to downloadWhatsAppMedia()
  timestamp: 1728550000,       // unix seconds
  contactName: 'Ali',
  rawPayload: { ... }
}
```

### 5.5 Reliability pipeline

| Step | Redis / BullMQ | Why |
|---|---|---|
| Ack first | `res.sendStatus(200)` before any work | Providers retry on slow or non-2xx responses |
| Dedupe | `SET wa:msg:<id> 1 EX 86400 NX` | Drops provider retries |
| Buffer | `RPUSH wa:buffer:<phone>` + `EXPIRE 3600` | Collects bursts ("hi" / "I need help" / photo) |
| Debounce | `dialogQueue.add('process-message', {phone}, {delay: 3000, attempts: 3, backoff: exponential 2000})` | Handles a burst as one turn |
| Lock (worker) | `SET lock:dialog:<phone> 1 EX 30 NX`, throws if already held → BullMQ retries | One conversation turn per phone at a time |
| Drain (worker) | `RENAME buffer → buffer:processing:<ts>`, `LRANGE 0 -1`, `DEL` | Atomic hand-off; new messages go to a fresh buffer |
| Merge (worker) | Texts joined with `\n`; `messageType`/`imageId` come from the **last** message | One combined input |

---

## 6. Phone Normalization

`normalizePhone(input) → '+E164' | ''`

- Returns `''` for group JIDs (`@g.us`) and broadcasts. Treat `''` as "ignore".
- Strips everything except digits and `+`.
- Pakistan-specific: `03xxxxxxxxx` → `+923xxxxxxxxx`, `92xxxxxxxxxx` → `+92…`.
- Anything else gets a `+` prefix. Valid lengths are 8–15 digits.

**For another country**, replace the `03`/`92` branches with that country's local trunk-prefix rule, or use `libphonenumber-js`.

---

## 7. Media Decryption (WASender full-resolution images)

WASender forwards Baileys-style payloads in which `imageMessage.url` points to an **encrypted** `mmg.whatsapp.net` file. The decryption steps:

```
mediaKeyExpanded = HKDF-SHA256(ikm = base64decode(mediaKey), salt = 32 zero bytes,
                               info = "WhatsApp Image Keys" | "WhatsApp Document Keys", len = 112)
iv        = expanded[0..16]
cipherKey = expanded[16..48]
ciphertext = downloaded bytes minus the last 10 bytes (MAC)
plaintext  = AES-256-CBC-decrypt(cipherKey, iv, ciphertext)
```

Other `info` strings, if you extend this: `"WhatsApp Video Keys"`, `"WhatsApp Audio Keys"`.

---

## 8. Templates

```js
const { getMessage } = require('./whatsapp.templates');
getMessage('EXPERT_NEW_TICKET', { category: 'Property', name: 'Ali', city: 'Lahore' }, 'english');
```

- Language falls back from the explicit argument to `SYSTEM_LANGUAGE`, then to `bilingual`.
- `{key}` placeholders are replaced globally. An unknown key throws.
- The WhatsApp formatting (`*bold*`, emoji, `\n`) is part of the strings.

These are plain text messages, **not** Meta-approved templates.

---

## 9. Porting to Another Application

### 9.1 Files to copy

```
whatsapp/
  whatsapp.service.js        # facade
  whatsapp.wasender.js       # and/or whatsapp.cloud.js, whatsapp.mock.js
  whatsapp.templates.js      # optional; replace the content
utils/
  whatsappMediaDecrypt.js    # needed for WASender images
  phoneNormalizer.js         # adjust the country rules
webhook/
  webhook.controller.js
  webhook.validator.js
  webhook.routes.js
```

Each file expects three things, which you need to provide or replace:
- `config/env` — an object with the variables in §3
- `utils/logger` — anything with `info/warn/error/debug` (pino in this project; `console` works)
- `config/redis` — exports `redisConnection` (an ioredis instance)

### 9.2 Minimal wiring

```js
// app.js
const express = require('express');
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/api', require('./webhook/webhook.routes'));
app.listen(3001);
```

```js
// queue.js
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const redis = new IORedis({ maxRetriesPerRequest: null });
const { sendWhatsAppMessage, downloadWhatsAppMedia } = require('./whatsapp/whatsapp.service');

const dialogQueue = new Queue('dialog-queue', { connection: redis });

new Worker('dialog-queue', async (job) => {
  const { phone } = job.data;
  const lockKey = `lock:dialog:${phone}`;
  if (!(await redis.set(lockKey, '1', 'EX', 30, 'NX'))) throw new Error('locked');
  try {
    const bufferKey = `wa:buffer:${phone}`;
    if (!(await redis.exists(bufferKey))) return;
    const tmp = `${bufferKey}:processing:${Date.now()}`;
    await redis.rename(bufferKey, tmp);
    const msgs = (await redis.lrange(tmp, 0, -1)).map(JSON.parse);
    await redis.del(tmp);

    const text = msgs.filter(m => m.text).map(m => m.text).join('\n');
    const last = msgs[msgs.length - 1];

    if (last.messageType === 'image' && last.imageId) {
      const { buffer, mimeType } = await downloadWhatsAppMedia(last.imageId);
      // ... store / process the image
    }

    // ---- your application logic here ----
    await sendWhatsAppMessage(phone, `You said: ${text}`);
  } finally {
    await redis.del(lockKey);
  }
}, { connection: redis });

module.exports = { dialogQueue };
```

If you don't need batching, you can replace the buffer and delayed job with a direct `queue.add('message', jobData)` and handle each message on its own.

### 9.3 Provider setup

**WASender**
1. Create a session in the WASender dashboard and link the WhatsApp number by scanning the QR code.
2. Copy the API key into `WHATSAPP_ACCESS_TOKEN`.
3. Set the webhook URL to `https://<domain>/api/webhook` and subscribe to `messages.received`.
4. Set `WHATSAPP_MODE=wasender`.

**Meta Cloud API**
1. In the Meta app, add WhatsApp and get the Phone Number ID and a permanent System User token.
2. Set the webhook callback to `https://<domain>/api/webhook`, use `WHATSAPP_VERIFY_TOKEN` as the verify token, and subscribe to `messages`.
3. Set `WHATSAPP_APP_SECRET` and `WHATSAPP_MODE=cloud`.

For local testing, expose the port with a tunnel such as ngrok or cloudflared.

---

## 10. Known Limitations & Recommended Hardening

These are worth fixing before or while you reuse the code:

1. **The WASender webhook isn't authenticated.** Anyone who knows the URL can inject messages. WASender can sign webhooks with a secret (`X-Webhook-Signature`). Verify it, or at minimum add a secret query parameter.
2. **Media MAC isn't verified, and MIME is hard-coded.** `whatsappMediaDecrypt.js` drops the 10-byte MAC without checking it, and always returns `image/jpeg` or `application/pdf`. Prefer the payload's `mimetype`, and verify `HMAC-SHA256(macKey = expanded[48..80], iv + ciphertext)[0..10]`.
3. **Only images are handled for WASender.** `documentMessage`, `audioMessage` and `videoMessage` arrive as `messageType: 'text'` with `text: null`. Extend the parser and pass the right HKDF `info` string.
4. **Meta Cloud mode reads only the first message**, `entry[0].changes[0].messages[0]`. Meta can batch several, so loop over all of them.
5. **The Cloud provider doesn't retry on 429.** Copy the retry logic from the WASender provider.
6. **The controller reads `process.env` while the rest of the code reads the validated `env` module.** Keep them consistent.
7. **The 30 s lock TTL** can expire during long AI calls, which would allow concurrent turns. Raise it or extend it while the turn runs.
8. **The Pakistan-specific normalizer** needs changing for other countries.
