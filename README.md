# 💬 WPSent

Self-hosted WhatsApp Web API bridge.

---

## Quick Start (Local)

```bash
# 1. Install a browser (if you don't have Chrome/Chromium)
sudo apt-get install -y chromium-browser   # Ubuntu/Debian

# 2. Configure
cp .env.example .env
# Edit .env → paste your MongoDB URI

# 3. Run
npm install
npm start
```

Open **http://localhost:3000** → enter phone → scan QR → dashboard.

---

## Authentication

Every API call requires **both** credentials:

| Query param | Header | Description |
|---|---|---|
| `clientid` | `x-client-id` | Public identifier |
| `key` | `x-api-key` | Secret key |

Both are shown on your dashboard after scanning the QR.

---

## REST API

### Send a message
```
POST /send?clientid=YOUR_CLIENT_ID&key=YOUR_SECRET_KEY&to=8801711000000
Content-Type: application/json

{ "message": "Hello!" }
```
Phone numbers are cleaned automatically — `+880 171...`, `880171...`, `+8801711000000` all work.

### Get logs
```
GET /logs?clientid=YOUR_CLIENT_ID&key=YOUR_SECRET_KEY
```

### Check status
```
GET /status?clientid=YOUR_CLIENT_ID&key=YOUR_SECRET_KEY
```

### Webhooks
```bash
# Add
POST /webhooks
x-client-id: YOUR_CLIENT_ID
x-api-key: YOUR_SECRET_KEY
{ "url": "https://yoursite.com/hook", "method": "POST", "label": "My Hook" }

# Toggle active/paused
PATCH /webhooks/:id   { "active": false }

# Delete
DELETE /webhooks/:id
```

---

## Webhook Payload

Fired on every inbound message — text, emoji, reaction, sticker, image, etc.

```json
{
  "event":     "message_received",
  "from":      "8801711000000",
  "body":      "Hello!",
  "type":      "text",
  "timestamp": "2024-01-01T10:30:00.000Z"
}
```

**Types:** `text` · `reaction` → `[Reaction: 👍]` · `sticker` · `image` · `video` · `audio` · `document` · `location` · `contact`

---

## MongoDB Collections

**`wpusers`**
```js
{ phone, clientId, apiKey, webhooks: [{url, method, label, active}], createdAt, lastSeen }
```

**`messagelogs`**
```js
{ userId, direction, to, from, body, type, status, error, timestamp }
```

**`whatsapp-sessions`** (auto-managed by MongoStore)
```js
{ sessionId, session }  ← full Chromium session, restored on restart
```

> Per-user log cap: **100 messages**. Oldest deleted automatically.

---

## Browser Support

The server auto-detects whichever browser is installed:

| Browser | Works? |
|---|---|
| Google Chrome | ✅ |
| Chromium | ✅ |
| Brave / Firefox / Safari | ❌ not supported by Puppeteer |
