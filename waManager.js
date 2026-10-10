const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore }         = require('wwebjs-mongo');
const mongoose               = require('mongoose');
const { WpUser, MessageLog } = require('./models');
const axios                  = require('axios');
const { execSync }           = require('child_process');
const fs                     = require('fs');
const path                   = require('path');

const sessions     = new Map(); // phone → { client, status, qr }
const qrCallbacks  = new Map(); // phone → [fn, ...]
const logListeners = new Map(); // userId → [fn, ...]
const reconnectTimers = new Map(); // phone → timeout (at most ONE pending reconnect per phone)
const retryCount      = new Map(); // phone → consecutive failed init attempts
const pairedAtMap     = new Map(); // phone → ms timestamp of the last *fresh QR pairing*

const RECONNECT_MS = Number(process.env.WA_RECONNECT_MS) || 5000;
const STAGGER_MS   = Number(process.env.WA_STAGGER_MS)   || 3000;
const MAX_RETRIES  = 10;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

//  ENOENT guard (RemoteAuth zip race on first sync) 
const _origEmit = process.emit.bind(process);
process.emit = function(event, error, ...args) {
  if (event === 'uncaughtException' && error?.code === 'ENOENT' && error?.path?.includes('RemoteAuth-')) {
    console.warn(`[WP] Ignoring benign RemoteAuth zip error (first sync): ${error.path}`);
    return true;
  }
  return _origEmit(event, error, ...args);
};

//  browser auto-detection

function isRealBrowser(p) {
  try {
    execSync(`test -f "${p}"`, { stdio: 'ignore' });
    const out = execSync(`"${p}" --version 2>&1 || true`, { timeout: 3000, encoding: 'utf8' });
    if (out.toLowerCase().includes('snap')) return false;
    console.log(`[WP] Browser: ${p} (${out.trim()})`);
    return true;
  } catch (_) { return false; }
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
  for (const p of candidates) { if (isRealBrowser(p)) return p; }
  console.log('[WP] Using Puppeteer bundled Chromium');
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
    const oldest   = await MessageLog.find({ userId }).sort({ timestamp: 1 }).limit(toDelete).select('_id');
    await MessageLog.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
  }
}

async function fireWebhooks(userId, payload) {
  const freshUser = await WpUser.findById(userId).lean();
  if (!freshUser) return;
  const active = (freshUser.webhooks || []).filter(w => w.active);
  if (!active.length) return;
  console.log(`[WH] Firing ${active.length} webhook(s)`);
  await Promise.allSettled(active.map(async (wh) => {
    try {
      if (wh.method === 'POST') {
        await axios.post(wh.url, payload, { timeout: 8000 });
      } else {
        const sep    = wh.url.includes('?') ? '&' : '?';
        const params = new URLSearchParams(payload).toString();
        await axios.get(`${wh.url}${sep}${params}`, { timeout: 8000 });
      }
      console.log(`[WH] OK: ${wh.url}`);
    } catch (e) {
      console.error(`[WH] Failed: ${wh.url} — ${e.message}`);
    }
  }));
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
  if (msg.type === 'location') return `[Location: ${msg.location?.latitude || '?'},${msg.location?.longitude || '?'}]`;
  if (msg.type === 'vcard')    return '[Contact card]';
  const body = msg.body || msg.caption || msg._data?.body || '';
  return body || `[${msg.type || 'message'}]`;
}

// teardown / reconnect 

async function teardown(phone) {
  const s = sessions.get(phone);
  sessions.delete(phone);
  if (!s) return;
  s.destroyed = true;              
  try { await Promise.race([s.client.destroy(), sleep(10_000)]); } catch (_) {}
}


function scheduleReconnect(phone, delay = RECONNECT_MS) {
  if (reconnectTimers.has(phone)) return;
  const s = sessions.get(phone);
  if (s) s.reconnecting = true;
  reconnectTimers.set(phone, setTimeout(async () => {
    reconnectTimers.delete(phone);
    await teardown(phone);          
    createSession(phone);
  }, delay));
}

//session factory
function createSession(phone) {
  const existing = sessions.get(phone);
  if (existing) {
    if (existing.status !== 'error' || existing.reconnecting) return existing;
  
    existing.destroyed = true;
    sessions.delete(phone);
    existing.client.destroy().catch(() => {});
  }

  const store  = new MongoStore({ mongoose });
  const auth   = new RemoteAuth({
      clientId:             phone,
      store,
      dataPath:             '/tmp',
      
      backupSyncIntervalMs: 60_000
    });
  const client = new Client({
    authStrategy: auth,
    puppeteer: {
      headless: true,
      ...(BROWSER_PATH && { executablePath: BROWSER_PATH }),
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
        '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'
      ]
    }
  });

  const session = { client, auth, status: 'initializing', qr: null, needsPair: false, destroyed: false, reconnecting: false };
  sessions.set(phone, session);

  client.on('qr', (qr) => {
    if (session.destroyed) return;
    session.qr        = qr;
    session.status    = 'qr_ready';
    session.needsPair = true;       // a QR was needed → the next 'ready' is a fresh pairing
    (qrCallbacks.get(phone) || []).forEach(fn => { try { fn(qr); } catch (_) {} });
  });

  client.on('ready', async () => {
    if (session.destroyed) return;
    session.status = 'ready';
    session.qr     = null;
    retryCount.delete(phone);
    if (session.needsPair) {        // proof that someone holding the phone scanned the QR
      pairedAtMap.set(phone, Date.now());
      session.needsPair = false;
    }
    console.log(`[WP] Ready: ${phone}`);
    try { await WpUser.updateOne({ phone }, { lastSeen: new Date() }); }
    catch (e) { console.error('[WP] lastSeen update failed:', e.message); }
  });

  client.on('remote_session_saved', () => {
    console.log(`[WP] Session saved to MongoDB: ${phone}`);
  });

  client.on('auth_failure', (msg) => {
    if (session.destroyed) return;
    session.status = 'auth_failure';
    console.error(`[WP] Auth failure for ${phone}:`, msg);
  });

  client.on('disconnected', (reason) => {
    if (session.destroyed) return;
    session.status = 'disconnected';
    console.log(`[WP] Disconnected ${phone}: ${reason} — reconnecting`);
    scheduleReconnect(phone);
  });

  client.on('error', (err) => {
    if (session.destroyed) return;
    const msg = err?.message || '';
    console.error(`[WP] Error ${phone}:`, msg);
    if (msg.includes('Target closed') || msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Protocol error')) {
      session.status = 'disconnected';
      scheduleReconnect(phone);
    }
  });

  client.on('message', async (msg) => {
    try {
     
      if (msg.from === 'status@broadcast' || msg.isStatus) return;
      const user = await WpUser.findOne({ phone });
      if (!user) return;
      const type = classifyMessage(msg);
      const body = extractBody(msg);
      const log  = await MessageLog.create({ userId: user._id, direction: 'inbound', from: msg.from, body, type, status: 'received' });
      await pruneOldLogs(user._id);
      emitLog(user._id.toString(), log.toObject());
      await fireWebhooks(user._id, { event: 'message_received', from: msg.from.replace('@c.us',''), body, type, timestamp: (log.timestamp || new Date()).toISOString() });
    } catch (e) { console.error('[WP] message handler error:', e.message); }
  });

  client.on('message_reaction', async (reaction) => {
    try {
      const user = await WpUser.findOne({ phone });
      if (!user) return;
      const body = `[Reaction: ${reaction.reaction || '👍'}]`;
      const log  = await MessageLog.create({ userId: user._id, direction: 'inbound', from: reaction.senderId || 'unknown', body, type: 'reaction', status: 'received' });
      await pruneOldLogs(user._id);
      emitLog(user._id.toString(), log.toObject());
      await fireWebhooks(user._id, { event: 'message_received', from: (reaction.senderId || 'unknown').replace('@c.us',''), body, type: 'reaction', timestamp: (log.timestamp || new Date()).toISOString() });
    } catch (e) { console.error('[WP] reaction handler error:', e.message); }
  });

  client.initialize().catch(err => {
    if (session.destroyed) return;
    console.error(`[WP] Init error for ${phone}:`, err.message);
    session.status = 'error';
   
    const n = (retryCount.get(phone) || 0) + 1;
    retryCount.set(phone, n);
    if (n <= MAX_RETRIES) scheduleReconnect(phone, Math.min(RECONNECT_MS * 2 ** (n - 1), 5 * 60_000));
    else console.error(`[WP] Giving up on ${phone} after ${MAX_RETRIES} failed attempts`);
  });

  return session;
}

// ── destroy 

async function wipeRemoteSession(phone) {
  const name = `RemoteAuth-${phone}`;
  try { await new MongoStore({ mongoose }).delete({ session: name }); }
  catch (e) { console.warn(`[WP] Could not delete remote session ${name}:`, e.message); }
  for (const p of [path.join('/tmp', name), `${name}.zip`, path.join('/tmp', `${name}.zip`)]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }
}

async function destroySession(phone, { wipe = false } = {}) {
  const t = reconnectTimers.get(phone);
  if (t) { clearTimeout(t); reconnectTimers.delete(phone); }   // don't resurrect it
  await teardown(phone);
  qrCallbacks.delete(phone);
  retryCount.delete(phone);
  pairedAtMap.delete(phone);
  if (wipe) await wipeRemoteSession(phone);
  console.log(`[WP] Session destroyed${wipe ? ' (remote session wiped)' : ''}: ${phone}`);
}

// public API 
function getSession(phone) { return sessions.get(phone) || null; }
function getStatus(phone)  { return sessions.get(phone)?.status || 'not_started'; }

function getPairedAt(phone) { return pairedAtMap.get(phone) || 0; }

function getOwnId(phone) {
  return sessions.get(phone)?.client?.info?.wid?._serialized || `${sanitizePhone(phone)}@c.us`;
}

function onQR(phone, fn) {
  if (!qrCallbacks.has(phone)) qrCallbacks.set(phone, []);
  qrCallbacks.get(phone).push(fn);
  const s = sessions.get(phone);
  if (s?.qr) fn(s.qr);
}
function offQR(phone, fn) {
  if (!qrCallbacks.has(phone)) return;
  qrCallbacks.set(phone, qrCallbacks.get(phone).filter(f => f !== fn));
}

function onLog(userId, fn) {
  if (!logListeners.has(userId)) logListeners.set(userId, []);
  logListeners.get(userId).push(fn);
}
function offLog(userId, fn) {
  if (!logListeners.has(userId)) return;
  logListeners.set(userId, logListeners.get(userId).filter(f => f !== fn));
}
function emitLog(userId, log) {
  (logListeners.get(userId) || []).forEach(fn => { try { fn(log); } catch (_) {} });
}

async function sendMessage(phone, to, body) {
  const session = sessions.get(phone);
  if (!session || session.status !== 'ready') throw new Error('WhatsApp session not ready');
  const clean = to.includes('@') ? to : sanitizePhone(to) + '@c.us';
  if (!clean || clean === '@c.us') throw new Error('Invalid phone number');
  try {
    await session.client.sendMessage(clean, body);
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('detached Frame') || msg.includes('Target closed') || msg.includes('Session closed')) {
      session.status = 'disconnected';
      scheduleReconnect(phone, 3000);
      throw new Error('Session lost — reconnecting, please retry in 30 seconds');
    }
    throw err;
  }
}


async function shutdown() {
  for (const t of reconnectTimers.values()) clearTimeout(t);
  reconnectTimers.clear();
  await Promise.allSettled([...sessions.entries()].map(async ([phone, s]) => {
    s.destroyed = true;                                   // no reconnects while closing
    if (s.status === 'ready') {
      try {
        await Promise.race([s.auth.storeRemoteSession({ emit: false }), sleep(20_000)]);
        console.log(`[WP] Saved session before shutdown: ${phone}`);
      } catch (e) { console.warn(`[WP] Could not save session ${phone}:`, e.message); }
    }
    try { await Promise.race([s.client.destroy(), sleep(5_000)]); } catch (_) {}
  }));
}

async function restoreAllSessions() {
  const users = await WpUser.find({}).select('phone').lean();
  users.forEach((u, i) => setTimeout(() => {
    console.log(`[WP] Restoring session: ${u.phone}`);
    createSession(u.phone);
  }, i * STAGGER_MS));
  return users.length;
}

module.exports = {
  createSession, destroySession, getSession, getStatus, getPairedAt, getOwnId,
  onQR, offQR, sendMessage, restoreAllSessions,
  pruneOldLogs, sanitizePhone, onLog, offLog, emitLog, shutdown
};
