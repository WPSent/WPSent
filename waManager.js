

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore }         = require('wwebjs-mongo');
const mongoose               = require('mongoose');
const { WpUser, MessageLog } = require('./models');
const axios                  = require('axios');
const { execSync }           = require('child_process');

const sessions    = new Map();  // phone → { client, status, qr }
const qrCallbacks = new Map();  // phone → [fn, ...]

//  browser auto-detection 

function isRealBrowser(p) {
  try {
    // File must exist
    execSync(`test -f "${p}"`, { stdio: 'ignore' });
    // Must not be a snap stub — stubs contain the word "snap" in their output
    const out = execSync(`"${p}" --version 2>&1 || true`, {
      timeout: 3000,
      encoding: 'utf8'
    });
    if (out.toLowerCase().includes('snap')) return false;
    console.log(`[WA]  Browser found: ${p} (${out.trim()})`);
    return true;
  } catch (_) {
    return false;
  }
}

function findBrowser() {
  const candidates = [
    // Nix (Railway nixpacks) — check first, most reliable on Railway
    '/nix/var/nix/profiles/default/bin/chromium',
    // Linux — Chrome (real binary, not a stub)
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    // Linux — Chromium real binary
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // macOS — Chrome
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // macOS — Chromium
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Windows — Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of candidates) {
    if (isRealBrowser(p)) return p;
  }

  console.log('[WA]  No system browser found — using Puppeteer bundled Chromium');
  return null;
}

const BROWSER_PATH = findBrowser();

//  helpers 

/** Strip all non-digit characters — handles +, spaces, dashes */
function sanitizePhone(raw) {
  return String(raw).replace(/[^0-9]/g, '');
}

async function pruneOldLogs(userId) {
  const total = await MessageLog.countDocuments({ userId });
  if (total > 100) {
    const toDelete = total - 100;
    const oldest   = await MessageLog.find({ userId })
      .sort({ timestamp: 1 }).limit(toDelete).select('_id');
    await MessageLog.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
  }
}

async function fireWebhooks(user, payload) {
  const active = (user.webhooks || []).filter(w => w.active);
  for (const wh of active) {
    try {
      if (wh.method === 'POST') {
        await axios.post(wh.url, payload, { timeout: 8000 });
      } else {
        const params = new URLSearchParams(payload).toString();
        await axios.get(`${wh.url}?${params}`, { timeout: 8000 });
      }
    } catch (_) { /* best-effort */ }
  }
}

function classifyMessage(msg) {
  const t = msg.type;
  if (t === 'reaction') return 'reaction';
  if (t === 'sticker')  return 'sticker';
  if (t === 'image')    return 'image';
  if (t === 'video')    return 'video';
  if (t === 'audio')    return 'audio';
  if (t === 'document') return 'document';
  if (t === 'location') return 'location';
  if (t === 'vcard')    return 'contact';
  return 'text';
}

function extractBody(msg) {
  if (msg.type === 'reaction') {
    const emoji = msg.reaction?.text || msg._data?.reactionText || '👍';
    return `[Reaction: ${emoji}]`;
  }
  if (msg.type === 'sticker')  return '[Sticker]';
  if (msg.type === 'image')    return msg.body || '[Image]';
  if (msg.type === 'video')    return '[Video]';
  if (msg.type === 'audio')    return '[Audio]';
  if (msg.type === 'document') return `[Document: ${msg.body || 'file'}]`;
  if (msg.type === 'location') return `[Location: ${msg.location?.latitude},${msg.location?.longitude}]`;
  if (msg.type === 'vcard')    return '[Contact card]';
  return msg.body || '';
}

//  session factory 

function createSession(phone) {
  if (sessions.has(phone)) return sessions.get(phone);

  // MongoStore requires an active mongoose connection — always true here
  // since server.js connects before calling restoreAllSessions()
  const store = new MongoStore({ mongoose });

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             phone,          // unique per user
      store,                                // MongoDB backend
      backupSyncIntervalMs: 60_000          // sync session every 60s
    }),
    puppeteer: {
      headless: true,
      ...(BROWSER_PATH && { executablePath: BROWSER_PATH }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  const session = { client, status: 'initializing', qr: null };
  sessions.set(phone, session);

  client.on('qr', (qr) => {
    session.qr     = qr;
    session.status = 'qr_ready';
    (qrCallbacks.get(phone) || []).forEach(fn => fn(qr));
  });

  client.on('ready', async () => {
    session.status = 'ready';
    session.qr     = null;
    await WpUser.updateOne({ phone }, { lastSeen: new Date() });
    console.log(`[WA]  Session ready: ${phone}`);
  });

  client.on('remote_session_saved', () => {
    console.log(`[WA]  Session saved to MongoDB: ${phone}`);
  });

  client.on('auth_failure', (msg) => {
    session.status = 'auth_failure';
    console.error(`[WA]  Auth failure for ${phone}:`, msg);
  });

  client.on('disconnected', (reason) => {
    session.status = 'disconnected';
    console.log(`[WA]   ${phone} disconnected: ${reason}`);
    // auto-reconnect after 5s
    setTimeout(() => {
      sessions.delete(phone);
      createSession(phone);
    }, 5000);
  });

  // inbound messages — text, emoji, sticker, media, location…
  client.on('message', async (msg) => {
    try {
      const user = await WpUser.findOne({ phone });
      if (!user) return;
      const msgType = classifyMessage(msg);
      const body    = extractBody(msg);
      const log     = await MessageLog.create({
        userId: user._id, direction: 'inbound',
        from: msg.from, body, type: msgType, status: 'received'
      });
      await pruneOldLogs(user._id);
      await fireWebhooks(user, {
        event: 'message_received',
        from:  msg.from.replace('@c.us', ''),
        body, type: msgType,
        timestamp: log.timestamp.toISOString()
      });
    } catch (e) {
      console.error('[WA] message handler error:', e.message);
    }
  });

  // reactions emitted as separate events by some WA versions
  client.on('message_reaction', async (reaction) => {
    try {
      const user = await WpUser.findOne({ phone });
      if (!user) return;
      const emoji = reaction.reaction || '👍';
      const body  = `[Reaction: ${emoji}]`;
      const log   = await MessageLog.create({
        userId: user._id, direction: 'inbound',
        from: reaction.senderId || 'unknown',
        body, type: 'reaction', status: 'received'
      });
      await pruneOldLogs(user._id);
      await fireWebhooks(user, {
        event: 'message_received',
        from:  (reaction.senderId || 'unknown').replace('@c.us', ''),
        body, type: 'reaction',
        timestamp: log.timestamp.toISOString()
      });
    } catch (e) {
      console.error('[WA] reaction handler error:', e.message);
    }
  });

  client.initialize().catch(err => {
    console.error(`[WA] init error for ${phone}:`, err.message);
    session.status = 'error';
  });

  return session;
}

//  public API 

function getSession(phone) { return sessions.get(phone) || null; }
function getStatus(phone)  { return sessions.get(phone)?.status || 'not_started'; }

function onQR(phone, fn) {
  if (!qrCallbacks.has(phone)) qrCallbacks.set(phone, []);
  qrCallbacks.get(phone).push(fn);
  const s = sessions.get(phone);
  if (s?.qr) fn(s.qr);   // fire immediately if QR already cached
}

function offQR(phone, fn) {
  if (!qrCallbacks.has(phone)) return;
  qrCallbacks.set(phone, qrCallbacks.get(phone).filter(f => f !== fn));
}

async function sendMessage(phone, to, body) {
  const session = sessions.get(phone);
  if (!session || session.status !== 'ready')
    throw new Error('WhatsApp session not ready');
  const clean = sanitizePhone(to);
  if (!clean) throw new Error('Invalid phone number');
  await session.client.sendMessage(clean + '@c.us', body);
}

async function restoreAllSessions() {
  const users = await WpUser.find({});
  for (const u of users) {
    console.log(`[WA]  Restoring session for ${u.phone}`);
    createSession(u.phone);
  }
}

module.exports = {
  createSession, getSession, getStatus,
  onQR, offQR, sendMessage,
  restoreAllSessions, pruneOldLogs, sanitizePhone
};