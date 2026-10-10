const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const qrcode   = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { WpUser, MessageLog } = require('../models');
const wa = require('../waManager');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes

 
const CONFIG = {
  GITHUB_URL:    'https://github.com/wpsent/wpsent',
  INSTAGRAM_URL: 'https://instagram.com/adnanisagoodboy',
  EMAIL:         'your@email.com',
  SITE_URL:      'https://wpsent.xyz',
  // Single-user
  SINGLE_USER:   process.env.SINGLE_USER === 'true' || false,
};


function genClientId() { return 'cid_' + crypto.randomBytes(6).toString('hex'); }
async function uniqueClientId() {
  for (let i = 0; i < 10; i++) {
    const id = genClientId();
    if (!(await WpUser.exists({ clientId: id }))) return id;
  }
  throw new Error('Could not generate a unique client ID');
}


const str = (v) => (typeof v === 'string' ? v : (Array.isArray(v) ? String(v[0] ?? '') : '')).trim();

// Constant-time comparison for secrets
function safeEq(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Express 4 doesn't catch rejected promises from async handlers (request just hangs).
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error('[route error]', req.method, req.path, e);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Internal server error' });
  });

// ── sessions / pairing 
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PAIR_TTL   = 10 * 60 * 1000;
const cookieOpts = (req, maxAge) => ({ httpOnly: true, sameSite: 'lax', signed: true, secure: !!req.secure, maxAge });
const keyTag     = (user) => crypto.createHash('sha256').update(String(user.apiKey)).digest('hex').slice(0, 16);

function setSession(req, res, user) {
  res.cookie('wpsent_phone', `${user.phone}:${keyTag(user)}`, cookieOpts(req, SESSION_MS));
}
async function userFromCookie(req) {
  const raw = req.signedCookies && req.signedCookies.wpsent_phone;   // false/undefined if forged
  if (typeof raw !== 'string') return null;
  const [phone, tag] = raw.split(':');
  if (!phone || !tag) return null;
  const user = await WpUser.findOne({ phone });
  return user && safeEq(keyTag(user), tag) ? user : null;
}


const pending = new Map();   // phone → { nonce, rotate, createdAt }
function startPairing(req, res, phone, rotate) {
  for (const [p, v] of pending) if (Date.now() - v.createdAt > PAIR_TTL) pending.delete(p);
  const nonce = crypto.randomBytes(16).toString('hex');
  pending.set(phone, { nonce, rotate, createdAt: Date.now() });
  res.cookie('wpsent_pair', `${phone}:${nonce}`, cookieOpts(req, PAIR_TTL));
}
function getPairing(req) {
  const raw = req.signedCookies && req.signedCookies.wpsent_pair;
  if (typeof raw !== 'string') return null;
  const [phone, nonce] = raw.split(':');
  const p = pending.get(phone);
  if (!p || Date.now() - p.createdAt > PAIR_TTL || !safeEq(p.nonce, nonce)) return null;
  return { phone, ...p };
}

async function rotateCredentials(phone) {
  return WpUser.findOneAndUpdate({ phone }, {
    clientId: await uniqueClientId(), apiKey: uuidv4(),
    loginAttempts: 0, lockedUntil: null,
    webhooks: []            
  }, { new: true });
}


const resetCodes   = new Map();   // phone → { code, exp, attempts }
const codeCooldown = new Map();   // phone → last request ms

// ── middleware: REST API ─
const requireKey = ah(async (req, res, next) => {
  const clientId = str(req.query.clientid || req.headers['x-client-id']);
  const key      = str(req.query.key      || req.headers['x-api-key']);
  if (!clientId) return res.status(401).json({ error: 'Missing clientid' });
  if (!key)      return res.status(401).json({ error: 'Missing key' });
  const user = await WpUser.findOne({ clientId });
  if (!user)                       return res.status(403).json({ error: 'Unknown client ID' });
  if (!safeEq(user.apiKey, key))   return res.status(403).json({ error: 'Invalid API key' });
  req.wpUser = user;
  next();
});

// ── middleware: dashboard (signed cookie only) 
const requireDashboard = ah(async (req, res, next) => {
  const user = await userFromCookie(req);
  if (!user) {
    res.clearCookie('wpsent_phone');
    return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Not signed in' }) : res.redirect('/');
  }
  if (wa.getStatus(user.phone) === 'not_started') wa.createSession(user.phone);
  req.wpPhone = user.phone;
  req.wpUser  = user;
  next();
});


router.get('/', (req, res) => res.send(landingHTML()));


router.get('/docs', (req, res) => res.send(docsHTML()));


router.post('/auth/start', ah(async (req, res) => {
  const phone = wa.sanitizePhone(str(req.body?.phone));
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const user = await WpUser.findOne({ phone });

  if (user) {
    return res.json({ ok: true, phone, existing: true });
  }

  // Single-user mode: block new registrations if any user exists
  if (CONFIG.SINGLE_USER) {
    const count = await WpUser.countDocuments();
    if (count >= 1) {
      return res.status(503).json({
        error: 'server_full',
        message: 'This server is at capacity. Please self-host your own instance.',
        github: CONFIG.GITHUB_URL,
        instagram: CONFIG.INSTAGRAM_URL,
        email: CONFIG.EMAIL
      });
    }
  }

  // New user
  try {
    await WpUser.create({ phone, clientId: await uniqueClientId(), apiKey: uuidv4() });
  } catch (e) {
    // two requests for the same new number at once -> duplicate key; treat as existing
    if (e && e.code === 11000) return res.json({ ok: true, phone, existing: true });
    throw e;
  }
  wa.createSession(phone);
  startPairing(req, res, phone, false);
  res.json({ ok: true, phone, existing: false });
}));


router.post('/auth/login', ah(async (req, res) => {
  const phone = wa.sanitizePhone(str(req.body?.phone));
  const key   = str(req.body?.key);
  if (!phone || !key) return res.status(400).json({ error: 'phone and key required' });

  const user = await WpUser.findOne({ phone });
  if (!user) return res.status(403).json({ error: 'User not found' });

  // Lockout check
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Locked. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`, locked: true, remaining });
  }

  if (!safeEq(user.apiKey, key)) {
    const attempts = (user.loginAttempts || 0) + 1;
    const left     = MAX_ATTEMPTS - attempts;
    if (attempts >= MAX_ATTEMPTS) {
      await WpUser.updateOne({ phone }, { loginAttempts: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MS) });
      return res.status(429).json({ error: 'Too many attempts. Locked for 15 minutes.', locked: true, remaining: 15 });
    }
    await WpUser.updateOne({ phone }, { loginAttempts: attempts });
    return res.status(403).json({ error: `Wrong secret key. ${left} attempt${left !== 1 ? 's' : ''} remaining.`, attemptsLeft: left });
  }

  await WpUser.updateOne({ phone }, { loginAttempts: 0, lockedUntil: null, lastSeen: new Date() });
  if (wa.getStatus(phone) === 'not_started') wa.createSession(phone);
  setSession(req, res, user);
  res.json({ ok: true, phone });
}));


router.post('/auth/reset', ah(async (req, res) => {
  const phone = wa.sanitizePhone(str(req.body?.phone));
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const user = await WpUser.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const st = wa.getStatus(phone);
  if (st === 'ready') {
    if (Date.now() - (codeCooldown.get(phone) || 0) < 60_000)
      return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
    codeCooldown.set(phone, Date.now());
    const code = String(crypto.randomInt(100000, 1000000));
    resetCodes.set(phone, { code, exp: Date.now() + 10 * 60_000, attempts: 0 });
    try {
      await wa.sendMessage(phone, wa.getOwnId(phone), `WPSent reset code: ${code}\nValid for 10 minutes. If you didn't request this, ignore it.`);
    } catch (e) {
      resetCodes.delete(phone);
      return res.status(502).json({ error: 'Could not deliver the code via WhatsApp: ' + e.message });
    }
    return res.json({ ok: true, mode: 'code' });
  }

  // Not connected:
  if (st === 'auth_failure') await wa.destroySession(phone, { wipe: true });   // saved login is invalid
  else if (st === 'error')   await wa.destroySession(phone);
  if (wa.getStatus(phone) === 'not_started') wa.createSession(phone);
  startPairing(req, res, phone, true);
  res.json({ ok: true, mode: 'qr' });
}));

router.post('/auth/reset/confirm', ah(async (req, res) => {
  const phone = wa.sanitizePhone(str(req.body?.phone));
  const code  = str(req.body?.code);
  const entry = resetCodes.get(phone);
  if (!entry || entry.exp < Date.now()) { resetCodes.delete(phone); return res.status(400).json({ error: 'Code expired. Request a new one.' }); }
  entry.attempts++;
  if (entry.attempts > 5) { resetCodes.delete(phone); return res.status(429).json({ error: 'Too many wrong codes. Request a new one.' }); }
  if (!safeEq(entry.code, code)) return res.status(403).json({ error: `Wrong code. ${5 - entry.attempts} attempt(s) left.` });
  resetCodes.delete(phone);
  const user = await rotateCredentials(phone);
  if (!user) return res.status(404).json({ error: 'User not found' });
  setSession(req, res, user);
  res.json({ ok: true });
}));


router.get('/auth/claim', ah(async (req, res) => {
  const p = getPairing(req);
  if (!p || wa.getPairedAt(p.phone) < p.createdAt) return res.redirect('/');   // no fresh scan → no login
  pending.delete(p.phone);
  res.clearCookie('wpsent_pair');
  const user = p.rotate ? await rotateCredentials(p.phone) : await WpUser.findOne({ phone: p.phone });
  if (!user) return res.redirect('/');
  setSession(req, res, user);
  res.redirect('/dashboard');
}));


router.get('/auth/qr-stream', (req, res) => {
  const p = getPairing(req);
  if (!p) return res.status(403).end('Start sign-in first');
  const phone = p.phone;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch(_){} };
  const sendQR = async (qr) => {
    try { send('qr', { dataUrl: await qrcode.toDataURL(qr, { width: 300 }) }); }
    catch (e) { console.error('[qr] render failed', e.message); }
  };
  let timer = null;
  const cleanup = () => { clearInterval(timer); wa.offQR(phone, sendQR); };

  const check = () => {
    if (wa.getPairedAt(phone) >= p.createdAt) { send('ready', {}); cleanup(); res.end(); return true; }
    // connected WITHOUT a fresh scan (auto-restored session) → can't be used to prove ownership
    if (wa.getStatus(phone) === 'ready')       { send('blocked', {}); cleanup(); res.end(); return true; }
    return false;
  };

  if (check()) return;
  wa.onQR(phone, sendQR);            // onQR replays the current QR immediately if there is one
  timer = setInterval(check, 2000);
  req.on('close', cleanup);
});


router.get('/dashboard', requireDashboard, (req, res) => {
  res.send(dashboardHTML(req.wpUser));
});


router.get('/logout', (req, res) => { res.clearCookie('wpsent_phone'); res.clearCookie('wpsent_pair'); res.redirect('/'); });


router.get('/api/me', requireDashboard, ah(async (req, res) => {
  const logs = await MessageLog.find({ userId: req.wpUser._id }).sort({ timestamp: -1 }).limit(100).lean();
  res.set('Cache-Control', 'no-store');   // never cache credentials
  res.json({
    apiKey:   req.wpUser.apiKey,
    clientId: req.wpUser.clientId,
    phone:    req.wpUser.phone,
    webhooks: req.wpUser.webhooks || [],
    status:   wa.getStatus(req.wpUser.phone),
    logs
  });
}));


router.get('/api/logs-stream', requireDashboard, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(_){} };
  const uid  = req.wpUser._id.toString();
  wa.onLog(uid, send);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(_){} }, 10000);
  req.on('close', () => { clearInterval(hb); wa.offLog(uid, send); });
});


router.post('/send', requireKey, ah(async (req, res) => {
  const rawTo   = str(req.query.to || req.body?.to);
  const message = str(req.body?.message || req.body?.body || req.query.message);
  const to      = rawTo.includes('@') ? rawTo : wa.sanitizePhone(rawTo);
  if (!to)      return res.status(400).json({ error: 'to is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  let status = 'sent', error = null;
  try { await wa.sendMessage(req.wpUser.phone, to, message); }
  catch (e) { status = 'failed'; error = e.message; }

  const log = await MessageLog.create({ userId: req.wpUser._id, direction: 'outbound', to, body: message, type: 'text', status, error });
  await wa.pruneOldLogs(req.wpUser._id);
  wa.emitLog(req.wpUser._id.toString(), log.toObject());

  if (status === 'failed') return res.status(500).json({ error, logId: log._id });
  res.json({ ok: true, logId: log._id });
}));


router.get('/logs', requireKey, ah(async (req, res) => {
  const logs = await MessageLog.find({ userId: req.wpUser._id }).sort({ timestamp: -1 }).limit(100);
  res.json(logs);
}));


router.get('/status', requireKey, (req, res) => {
  res.json({ phone: req.wpUser.phone, status: wa.getStatus(req.wpUser.phone) });
});


router.post('/webhooks', requireKey, ah(async (req, res) => {
  const url    = str(req.body?.url);
  const method = str(req.body?.method).toUpperCase() === 'GET' ? 'GET' : 'POST';
  const label  = str(req.body?.label);
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http:// or https://' });
  const user = await WpUser.findByIdAndUpdate(req.wpUser._id, { $push: { webhooks: { url, method, label } } }, { new: true });
  res.json({ ok: true, webhooks: user.webhooks });
}));
router.delete('/webhooks/:id', requireKey, ah(async (req, res) => {
  const user = await WpUser.findByIdAndUpdate(req.wpUser._id, { $pull: { webhooks: { _id: req.params.id } } }, { new: true });
  res.json({ ok: true, webhooks: user.webhooks });
}));
router.patch('/webhooks/:id', requireKey, ah(async (req, res) => {
  await WpUser.updateOne(
    { _id: req.wpUser._id, 'webhooks._id': req.params.id },
    { $set: { 'webhooks.$.active': req.body?.active === true || req.body?.active === 'true' } }
  );
  res.json({ ok: true });
}));

module.exports = router;

function landingHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WPSent - WhatsApp API Gateway</title>
<meta name="description" content="Self-hosted WhatsApp API gateway. Send messages, receive webhooks, no fees ever."/>
<meta name="robots" content="index, follow"/>
<meta name="keywords" content="WhatsApp API, WhatsApp gateway, self-hosted WhatsApp, WhatsApp webhook, WPSent"/>
<meta name="theme-color" content="#25d366"/>
<meta property="og:title" content="WPSent - WhatsApp API Gateway"/>
<meta property="og:description" content="Send WhatsApp messages via REST API. Free, self-hosted, open source."/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%2325d366'/><polygon points='14,30 50,18 42,46 28,32' fill='%230d0d0d'/></svg>"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0d0d0d;--surf:#161616;--surf2:#1f1f1f;--border:#2a2a2a;
  --green:#25d366;--text:#e8e8e8;--muted:#666;--danger:#e74c3c;--warn:#f39c12;--blue:#3498db;
  --r:12px;--rs:8px;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;min-height:100vh;display:flex;flex-direction:column;}
/* topbar */
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;
  border-bottom:1px solid var(--border);background:rgba(13,13,13,.95);backdrop-filter:blur(10px);
  position:sticky;top:0;z-index:100;}
.nav-logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;text-decoration:none;color:var(--text);}
.nav-icon{width:30px;height:30px;background:var(--green);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;}
.nav-links{display:flex;align-items:center;gap:6px;}
.nav-link{font-size:12px;color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:20px;border:1px solid transparent;transition:all .15s;}
.nav-link:hover{color:var(--text);border-color:var(--border);}
.nav-link.gh{background:var(--surf2);border-color:var(--border);color:var(--text);display:flex;align-items:center;gap:6px;}
/* hero */
.hero{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:60px 24px 40px;}
.hero-icon{width:72px;height:72px;background:var(--green);border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:36px;margin-bottom:20px;box-shadow:0 0 40px rgba(37,211,102,.25);}
.hero h1{font-size:36px;font-weight:700;margin-bottom:10px;letter-spacing:-.5px;}
.hero h1 span{color:var(--green);}
.hero p{font-size:15px;color:var(--muted);text-align:center;max-width:420px;line-height:1.7;margin-bottom:32px;}
.features{display:flex;gap:12px;margin-bottom:40px;flex-wrap:wrap;justify-content:center;}
.feat{background:var(--surf);border:1px solid var(--border);border-radius:var(--rs);padding:8px 14px;font-size:12px;color:var(--muted);}
/* card */
.card{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);padding:28px;width:100%;max-width:420px;}
.step{display:none;}.step.active{display:block;}
h2{font-size:17px;font-weight:600;margin-bottom:6px;}
p.hint{font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6;}
label{font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;display:block;margin-bottom:7px;}
input{width:100%;background:var(--surf2);border:1px solid var(--border);border-radius:var(--rs);
  padding:12px 14px;color:var(--text);font-size:14px;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color .15s;}
input:focus{border-color:var(--green);}
.btn{width:100%;background:var(--green);color:#000;font-weight:600;font-size:14px;border:none;
  border-radius:var(--rs);padding:12px;cursor:pointer;margin-top:12px;transition:opacity .15s;}
.btn:hover{opacity:.88;}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border);margin-top:8px;}
.btn-red{background:#2a0a0a;color:var(--danger);border:1px solid #5a1a1a;margin-top:8px;}
.err{font-size:12px;color:var(--danger);background:#1a0505;border:1px solid #3a1010;
  padding:8px 12px;border-radius:var(--rs);margin-top:10px;display:none;line-height:1.5;}
.warn-box{font-size:12px;color:var(--warn);background:#1a1205;border:1px solid #3a2a10;
  padding:10px 12px;border-radius:var(--rs);margin-bottom:14px;line-height:1.6;}
.note{font-size:11px;color:var(--muted);margin-top:7px;line-height:1.5;}
hr.div{border:none;border-top:1px solid var(--border);margin:16px 0;}
.back{font-size:12px;color:var(--muted);cursor:pointer;text-align:center;margin-top:14px;
  display:block;text-decoration:underline;}
.back:hover{color:var(--text);}
/* QR */
.qr-wrap{background:#fff;border-radius:var(--r);padding:14px;display:none;margin:14px auto;width:fit-content;}
.qr-wrap img{display:block;width:220px;height:220px;}
.status-row{display:flex;align-items:center;gap:8px;justify-content:center;font-size:13px;color:var(--muted);margin:10px 0;}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 1.2s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
/* server full */
.sf-icon{font-size:48px;text-align:center;margin-bottom:12px;}
.sf-links{display:flex;flex-direction:column;gap:8px;margin-top:16px;}
.sf-link{display:flex;align-items:center;gap:10px;background:var(--surf2);border:1px solid var(--border);
  border-radius:var(--rs);padding:12px 14px;text-decoration:none;color:var(--text);font-size:13px;transition:border-color .15s;}
.sf-link:hover{border-color:var(--green);}
.sf-link-icon{font-size:18px;flex-shrink:0;}
/* lock countdown */
.lock-num{font-size:24px;font-weight:700;color:var(--warn);text-align:center;margin:12px 0;}
/* footer */
footer{text-align:center;padding:24px;font-size:11px;color:var(--muted);}
footer a{color:var(--muted);text-decoration:none;margin:0 6px;}
footer a:hover{color:var(--text);}
</style>
</head>
<body>
<nav class="nav">
  <a class="nav-logo" href="/"><div class="nav-icon">💬</div>WPSent</a>
  <div class="nav-links">
    <a class="nav-link" href="/docs">Docs</a>
    <a class="nav-link gh" href="${CONFIG.GITHUB_URL}" target="_blank">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
      GitHub
    </a>
  </div>
</nav>

<div class="hero">
  <div class="hero-icon">💬</div>
  <h1>WP<span>Sent</span></h1>
  <p>Self-hosted WhatsApp API gateway. Send messages, receive webhooks, manage everything via REST API — no fees, ever.</p>
  <div class="features">
    <div class="feat">REST API</div>
    <div class="feat">Webhooks</div>
    <div class="feat">Live Dashboard</div>
    <div class="feat">Multi-format support</div>
    <div class="feat">MongoDB sessions</div>
    <div class="feat">Open Source</div>
  </div>

  <div class="card">

    <!-- STEP: phone -->
    <div class="step active" id="s-phone">
      <h2>Get started</h2>
      <p class="hint">Enter your WhatsApp number to sign in or create an account.</p>
      <label>Phone number</label>
      <input id="inp-phone" type="tel" placeholder="+880 1XXX XXX XXX" autocomplete="tel"/>
      <p class="note">+, spaces, dashes are all fine.</p>
      <button class="btn" id="btn-phone" onclick="submitPhone()">Continue &rarr;</button>
      <div class="err" id="err-phone"></div>
    </div>

    <!-- STEP: secret key login -->
    <div class="step" id="s-key">
      <h2>Enter your Secret Key</h2>
      <p class="hint">Your account exists. Paste your Secret Key to sign in.</p>
      <label>Secret Key</label>
      <input id="inp-key" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
      <p class="note">Your Secret Key is shown on the dashboard after your first login.</p>
      <button class="btn" id="btn-key" onclick="submitKey()">Sign In &rarr;</button>
      <div class="err" id="err-key"></div>
      <hr class="div"/>
      <p style="font-size:12px;color:var(--muted);margin-bottom:8px">Forgot your key?</p>
      <button class="btn btn-red" onclick="showReset()">Reset Secret Key</button>
      <span class="back" onclick="goBack()">&larr; Different number</span>
    </div>

    <!-- STEP: locked -->
    <div class="step" id="s-locked">
      <h2>Account locked</h2>
      <p class="hint">Too many failed attempts.</p>
      <div class="lock-num" id="lock-countdown">--:--</div>
      <p style="text-align:center;font-size:12px;color:var(--muted)">Try again when the timer reaches 0.</p>
      <span class="back" onclick="goBack()">&larr; Different number</span>
    </div>

    <!-- STEP: new user QR -->
    <div class="step" id="s-qr">
      <h2>Scan QR Code</h2>
      <p class="hint">Open WhatsApp &rarr; Linked Devices &rarr; Link a Device &rarr; scan.</p>
      <div class="status-row" id="qr-status"><div class="dot"></div> Starting engine&hellip;</div>
      <div class="qr-wrap" id="qr-box"><img id="qr-img" src="" alt="QR"/></div>
      <p class="note">After scanning you will go straight to your dashboard. Your Secret Key will be shown there.</p>
      <span class="back" onclick="goBack()">&larr; Different number</span>
    </div>

    <!-- STEP: reset confirm -->
    <div class="step" id="s-reset">
      <h2>Reset account?</h2>
      <div class="warn-box">This creates a <b>new Client ID and Secret Key</b> (the old ones stop working) and removes your webhooks. To prove the number is yours, we will send a 6-digit code to your own WhatsApp chat &mdash; or, if WhatsApp is not connected, ask you to scan a QR code.</div>
      <button class="btn btn-red" id="btn-reset" onclick="confirmReset()">Yes, reset my key</button>
      <button class="btn btn-ghost" onclick="showStep('s-key')">Cancel</button>
    </div>

    <!-- STEP: reset code -->
    <div class="step" id="s-code">
      <h2>Check your WhatsApp</h2>
      <p class="hint">We sent a 6-digit code to your own WhatsApp chat (&ldquo;Message yourself&rdquo;). Enter it to get a new Secret Key.</p>
      <label>Code</label>
      <input id="inp-code" type="text" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"/>
      <button class="btn" id="btn-code" onclick="submitCode()">Verify &rarr;</button>
      <div class="err" id="err-code"></div>
      <span class="back" onclick="goBack()">&larr; Different number</span>
    </div>

    <!-- STEP: server full -->
    <div class="step" id="s-full">
      <div class="sf-icon">&#128274;</div>
      <h2>Server at capacity</h2>
      <p class="hint">This hosted instance is personal. Please self-host your own free instance &mdash; it only takes a few minutes.</p>
      <div class="sf-links">
        <a class="sf-link" href="${CONFIG.GITHUB_URL}" target="_blank">
          <span class="sf-link-icon">&#128196;</span>
          <div><strong>Self-host on GitHub</strong><br><small style="color:var(--muted)">Free, open source, deploy to Railway in 2 min</small></div>
        </a>
        <a class="sf-link" href="${CONFIG.INSTAGRAM_URL}" target="_blank">
          <span class="sf-link-icon">&#128247;</span>
          <div><strong>Contact on Instagram</strong><br><small style="color:var(--muted)">Need help setting it up?</small></div>
        </a>
        <a class="sf-link" href="mailto:${CONFIG.EMAIL}">
          <span class="sf-link-icon">&#128140;</span>
          <div><strong>Email us</strong><br><small style="color:var(--muted)">${CONFIG.EMAIL}</small></div>
        </a>
      </div>
      <span class="back" onclick="goBack()">&larr; Try a different number</span>
    </div>

  </div>
</div>

<footer>
  <a href="/docs">API Docs</a>
  <a href="${CONFIG.GITHUB_URL}" target="_blank">GitHub</a>
  <a href="${CONFIG.INSTAGRAM_URL}" target="_blank">Instagram</a>
  <a href="mailto:${CONFIG.EMAIL}">Contact</a>
</footer>

<script>
var phone = '';
var lockTimer = null;
var qrES = null;

function showStep(id) {
  document.querySelectorAll('.step').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

function showErr(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(function(){ el.style.display = 'none'; }, 5000);
}

function goBack() {
  phone = '';
  if (qrES) { qrES.close(); qrES = null; }
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
  showStep('s-phone');
}

function showReset() { showStep('s-reset'); }

function startLockTimer(seconds) {
  if (lockTimer) clearInterval(lockTimer);
  var s = seconds;
  var el = document.getElementById('lock-countdown');
  function tick() {
    var m = Math.floor(s/60), sec = s % 60;
    el.textContent = m + ':' + (sec < 10 ? '0' : '') + sec;
    if (s <= 0) { clearInterval(lockTimer); showStep('s-key'); }
    s--;
  }
  tick();
  lockTimer = setInterval(tick, 1000);
  showStep('s-locked');
}

async function submitPhone() {
  var raw = document.getElementById('inp-phone').value.trim();
  if (!raw) return;
  var btn = document.getElementById('btn-phone');
  btn.disabled = true; btn.textContent = 'Checking...';
  try {
    var res  = await fetch('/auth/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phone: raw }) });
    var data = await res.json();
    if (data.error === 'server_full') { showStep('s-full'); return; }
    if (!res.ok) { showErr('err-phone', data.error || 'Error'); return; }
    phone = data.phone;
    if (data.existing) { showStep('s-key'); setTimeout(function(){ document.getElementById('inp-key').focus(); }, 80); }
    else { showStep('s-qr'); startQR(); }
  } catch(e) { showErr('err-phone', 'Network error'); }
  finally { btn.disabled = false; btn.textContent = 'Continue \u2192'; }
}

async function submitKey() {
  var key = document.getElementById('inp-key').value.trim();
  if (!key) return;
  var btn = document.getElementById('btn-key');
  btn.disabled = true; btn.textContent = 'Verifying...';
  try {
    var res  = await fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phone: phone, key: key }) });
    var data = await res.json();
    if (!res.ok) {
      if (data.locked) { startLockTimer(data.remaining * 60); return; }
      document.getElementById('inp-key').style.borderColor = '#e74c3c';
      setTimeout(function(){ document.getElementById('inp-key').style.borderColor = ''; }, 1500);
      showErr('err-key', data.error || 'Wrong key');
      return;
    }
    window.location.href = '/dashboard';
  } catch(e) { showErr('err-key', 'Network error'); }
  finally { btn.disabled = false; btn.textContent = 'Sign In \u2192'; }
}

function startQR() {
  if (qrES) qrES.close();
  var es = qrES = new EventSource('/auth/qr-stream');
  es.addEventListener('qr', function(e) {
    var d = JSON.parse(e.data);
    document.getElementById('qr-img').src = d.dataUrl;
    document.getElementById('qr-box').style.display = 'block';
    document.getElementById('qr-status').innerHTML = '<div class="dot"></div> Scan with WhatsApp';
  });
  es.addEventListener('ready', function() {
    es.close();
    document.getElementById('qr-status').textContent = 'Connected! Going to dashboard...';
    document.getElementById('qr-box').style.display = 'none';
    setTimeout(function(){ window.location.href = '/auth/claim'; }, 600);
  });
  es.addEventListener('blocked', function() {
    es.close();
    document.getElementById('qr-box').style.display = 'none';
    document.getElementById('qr-status').textContent = 'This number is already connected. Go back, choose Reset Secret Key and use the code we send to your WhatsApp.';
  });
  es.onerror = function() {
    if (es.readyState === 2) document.getElementById('qr-status').textContent = 'Session expired. Go back and start again.';
  };
}

async function confirmReset() {
  var btn = document.getElementById('btn-reset');
  btn.disabled = true; btn.textContent = 'Working...';
  try {
    var res  = await fetch('/auth/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phone: phone }) });
    var data = await res.json();
    if (!res.ok) { showStep('s-key'); showErr('err-key', data.error || 'Reset failed'); return; }
    if (data.mode === 'code') { showStep('s-code'); setTimeout(function(){ document.getElementById('inp-code').focus(); }, 80); }
    else { showStep('s-qr'); startQR(); }
  } catch(e) { showStep('s-key'); showErr('err-key', 'Network error'); }
  finally { btn.disabled = false; btn.textContent = 'Yes, reset my key'; }
}

async function submitCode() {
  var code = document.getElementById('inp-code').value.trim();
  if (!code) return;
  var btn = document.getElementById('btn-code');
  btn.disabled = true; btn.textContent = 'Verifying...';
  try {
    var res  = await fetch('/auth/reset/confirm', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phone: phone, code: code }) });
    var data = await res.json();
    if (!res.ok) { showErr('err-code', data.error || 'Wrong code'); return; }
    window.location.href = '/dashboard';
  } catch(e) { showErr('err-code', 'Network error'); }
  finally { btn.disabled = false; btn.textContent = 'Verify \u2192'; }
}

document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('inp-phone').addEventListener('keydown', function(e){ if(e.key==='Enter') submitPhone(); });
  document.getElementById('inp-key').addEventListener('keydown',   function(e){ if(e.key==='Enter') submitKey(); });
  document.getElementById('inp-code').addEventListener('keydown',  function(e){ if(e.key==='Enter') submitCode(); });
});
</script>
</body>
</html>`;
}


function dashboardHTML(user) {
  
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WPSent Dashboard</title>
<meta name="robots" content="noindex,nofollow"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%2325d366'/><polygon points='14,30 50,18 42,46 28,32' fill='%230d0d0d'/></svg>"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0d0d0d;--surf:#161616;--surf2:#1f1f1f;--border:#2a2a2a;
  --green:#25d366;--gdim:#1a9e4a;--text:#e8e8e8;--muted:#666;
  --danger:#e74c3c;--warn:#f39c12;--blue:#3498db;--purple:#9b59b6;--r:12px;--rs:8px;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;min-height:100vh;}
/* topbar */
.bar{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;
  border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;
  background:rgba(13,13,13,.95);backdrop-filter:blur(10px);}
.bar-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;}
.bar-icon{width:28px;height:28px;background:var(--green);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;}
.bar-right{display:flex;align-items:center;gap:8px;}
.pill{display:flex;align-items:center;gap:5px;font-size:12px;background:var(--surf2);
  border:1px solid var(--border);padding:5px 11px;border-radius:20px;}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);}
.live-pill{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
  color:var(--green);background:#1a3a26;border:1px solid #2a5a36;padding:5px 10px;border-radius:20px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.out-btn{font-size:12px;color:var(--muted);background:none;border:1px solid var(--border);
  padding:5px 11px;border-radius:20px;cursor:pointer;text-decoration:none;}
.out-btn:hover{color:var(--text);border-color:var(--muted);}
/* layout */
main{max-width:1140px;margin:0 auto;padding:24px;}
/* stats */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
@media(max-width:680px){.stats{grid-template-columns:repeat(2,1fr);}}
.stat{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);padding:16px;text-align:center;}
.stat-n{font-size:28px;font-weight:700;color:var(--green);}
.stat-l{font-size:11px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.5px;}
/* creds */
.cred-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px;}
@media(max-width:680px){.cred-grid{grid-template-columns:1fr;}}
.card{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);padding:20px;}
.ct{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:10px;font-weight:600;}
.ci{margin-bottom:12px;}.ci:last-child{margin-bottom:0;}
.cl{font-size:11px;color:var(--muted);margin-bottom:4px;}
.cv{font-family:'JetBrains Mono',monospace;font-size:13px;background:var(--surf2);
  border:1px solid var(--border);border-radius:var(--rs);padding:9px 12px;
  color:var(--green);word-break:break-all;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;transition:border-color .15s;}
.cv:hover{border-color:var(--green);}
.cc{font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;}
/* tabs */
.tabs{display:flex;gap:2px;margin-bottom:18px;border-bottom:1px solid var(--border);}
.tab{padding:9px 16px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;
  color:var(--muted);transition:all .15s;white-space:nowrap;}
.tab.on{color:var(--text);border-bottom-color:var(--green);}
.panel{display:none;}.panel.on{display:block;}
/* table */
.twrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;min-width:580px;}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;
  padding:9px 11px;text-align:left;border-bottom:1px solid var(--border);}
td{padding:10px 11px;font-size:13px;border-bottom:1px solid var(--surf2);vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr.nr{animation:fi .4s ease;}
@keyframes fi{from{background:#1a3a26;opacity:.6}to{background:transparent;opacity:1}}
.b{display:inline-flex;align-items:center;font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;white-space:nowrap;}
.bs{background:#1a3a26;color:var(--green);}
.bf{background:#3a1a1a;color:var(--danger);}
.br{background:#1a2a3a;color:var(--blue);}
.bx{background:#2a1a3a;color:var(--purple);}
.bo{background:#2a2010;color:var(--warn);}
.mono{font-family:'JetBrains Mono',monospace;font-size:12px;}
.empty{text-align:center;padding:40px 20px;color:var(--muted);}
/* forms */
label{font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;display:block;margin-bottom:6px;}
input.fi,select.fi,textarea.fi{width:100%;background:var(--surf2);border:1px solid var(--border);
  border-radius:var(--rs);padding:10px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none;margin-bottom:12px;}
input.fi:focus,select.fi:focus,textarea.fi:focus{border-color:var(--green);}
textarea.fi{resize:vertical;min-height:80px;}
.btn{background:var(--green);color:#000;font-weight:600;font-size:13px;border:none;border-radius:var(--rs);padding:9px 16px;cursor:pointer;transition:opacity .15s;}
.btn:hover{opacity:.85;}
.btn-g{background:var(--surf2);color:var(--text);border:1px solid var(--border);}
.btn-d{background:#3a1a1a;color:var(--danger);border:1px solid #5a2a2a;}
.btn-s{padding:5px 11px;font-size:12px;}
.row{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;}
/* playground */
.pr{background:var(--surf2);border:1px solid var(--border);border-radius:var(--rs);padding:12px;
  min-height:60px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;
  white-space:pre-wrap;word-break:break-all;color:var(--muted);margin-top:12px;}
.pr.ok{color:var(--green);border-color:var(--gdim);}
.pr.er{color:var(--danger);border-color:#5a2a2a;}
/* code */
.cb{background:var(--surf2);border:1px solid var(--border);border-radius:var(--rs);padding:14px;
  font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;
  word-break:break-all;color:#aaa;margin-bottom:14px;position:relative;}
.cp{position:absolute;top:8px;right:8px;background:var(--surf);border:1px solid var(--border);
  color:var(--muted);font-size:11px;padding:3px 9px;border-radius:6px;cursor:pointer;font-family:inherit;}
.cp:hover{color:var(--text);}
.lt{display:flex;gap:4px;margin-bottom:10px;}
.ltb{padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;border-radius:6px 6px 0 0;
  background:var(--surf2);color:var(--muted);border:1px solid var(--border);border-bottom:none;}
.ltb.on{background:var(--surf);color:var(--text);}
/* webhook */
.wi{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid var(--surf2);}
.wi:last-child{border-bottom:none;}
.wu{font-family:'JetBrains Mono',monospace;font-size:12px;word-break:break-all;}
.wm{font-size:11px;color:var(--muted);margin-top:2px;}
/* toast */
.toast{position:fixed;bottom:20px;right:20px;background:#1a3a26;color:var(--green);border:1px solid var(--gdim);
  padding:10px 16px;border-radius:var(--rs);font-size:13px;font-weight:500;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9999;}
.toast.on{opacity:1;}
/* loading */
.loading{text-align:center;padding:40px;color:var(--muted);font-size:13px;}
</style>
</head>
<body>
<div class="bar">
  <div class="bar-logo"><div class="bar-icon">💬</div>WPSent</div>
  <div class="bar-right">
    <div class="live-pill" id="live-pill"><div class="live-dot"></div>LIVE</div>
    <div class="pill"><div class="dot"></div><span id="bar-phone">${String(user.phone).replace(/[^0-9+]/g,'')}</span></div>
    <a class="out-btn" href="/logout">Logout</a>
  </div>
</div>
<main>
  <div class="stats" id="stats"><div class="loading">Loading...</div></div>
  <div class="cred-grid" id="creds"><div class="loading">Loading...</div></div>
  <div class="tabs">
    <div class="tab on"  id="t-logs"       onclick="sw('logs')">Logs</div>
    <div class="tab"     id="t-playground" onclick="sw('playground')">Playground</div>
    <div class="tab"     id="t-webhooks"   onclick="sw('webhooks')">Webhooks</div>
    <div class="tab"     id="t-examples"   onclick="sw('examples')">Examples</div>
  </div>
  <div class="panel on" id="p-logs"><div class="loading">Loading...</div></div>
  <div class="panel"    id="p-playground"></div>
  <div class="panel"    id="p-webhooks"></div>
  <div class="panel"    id="p-examples"></div>
</main>
<div class="toast" id="toast"></div>

<script>
var KEY = '', CID = '', LOGS = [], HOOKS = [];

// ── load data via API — no inline injection ─
async function boot() {
  try {
    var res  = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.redirected || !res.ok) { window.location.href = '/'; return; }
    var data = await res.json();
    KEY   = data.apiKey;
    CID   = data.clientId;
    LOGS  = data.logs  || [];
    HOOKS = data.webhooks || [];
    renderAll();
    startSSE();
  } catch(e) {
    document.getElementById('stats').innerHTML = '<div class="loading">Failed to load. Refresh the page.</div>';
  }
}

function renderAll() {
  renderStats();
  renderCreds();
  renderLogs();
  renderPlayground();
  renderWebhooks();
  renderExamples();
}

// ── stats ───
function renderStats() {
  var sent = LOGS.filter(function(l){ return l.status==='sent'; }).length;
  var recv = LOGS.filter(function(l){ return l.status==='received'; }).length;
  var fail = LOGS.filter(function(l){ return l.status==='failed'; }).length;
  document.getElementById('stats').innerHTML =
    stat(LOGS.length,'Total') + stat(sent,'Sent') + stat(recv,'Received') + stat(fail,'Failed');
}
function stat(n,l){ return '<div class="stat"><div class="stat-n">'+n+'</div><div class="stat-l">'+l+'</div></div>'; }

// ── credentials ────────
var keyVis = false;
function renderCreds() {
  document.getElementById('creds').innerHTML =
    '<div class="card">' +
      '<div class="ct">Your Credentials</div>' +
      '<div class="ci"><div class="cl">Client ID <span style="color:var(--blue);font-size:10px">(public)</span></div>' +
        '<div class="cv" onclick="cp(CID,\'Client ID\')"><span id="d-cid">'+esc(CID)+'</span><span class="cc">copy</span></div></div>' +
      '<div class="ci"><div class="cl">Secret Key <span style="color:var(--danger);font-size:10px">(keep private &mdash; also your login password)</span></div>' +
        '<div class="cv" onclick="cp(KEY,\'Secret Key\')"><span id="d-key">'+mask(KEY)+'</span>' +
        '<span class="cc" onclick="event.stopPropagation();toggleKey()">reveal</span></div></div>' +
      '<p style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5">Your Secret Key is your login password. Keep it private.</p>' +
    '</div>' +
    '<div class="card">' +
      '<div class="ct">Quick Send</div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;background:var(--surf2);border:1px solid var(--border);border-radius:var(--rs);padding:11px;color:#aaa;line-height:1.7;word-break:break-all">' +
        'POST /send?clientid=<span style="color:var(--blue)">'+esc(CID)+'</span>&amp;key=<span style="color:var(--danger)">YOUR_KEY</span>&amp;to=<span style="color:var(--green)">880132...</span><br>{"message": "Hello!"}' +
      '</div>' +
      '<p style="font-size:11px;color:var(--muted);margin-top:8px"><a href="/docs" style="color:var(--green);text-decoration:none">Full API docs &rarr;</a></p>' +
    '</div>';
}
function mask(k){ return k ? k.slice(0,8)+'****************************' : ''; }
function toggleKey(){
  keyVis=!keyVis;
  var el=document.getElementById('d-key');
  if(el) el.textContent = keyVis ? KEY : mask(KEY);
}

// ── logs ────
function renderLogs() {
  if (!LOGS.length) {
    document.getElementById('p-logs').innerHTML = '<div class="card"><div class="empty">No messages yet.</div></div>';
    return;
  }
  var rows = LOGS.map(function(l){ return logRow(l, false); }).join('');
  document.getElementById('p-logs').innerHTML =
    '<div class="card"><div class="twrap"><table>' +
    '<thead><tr><th>Time</th><th>Dir</th><th>Number</th><th>Type</th><th>Message</th><th>Status</th></tr></thead>' +
    '<tbody id="log-body">' + rows + '</tbody></table></div></div>';
}

function logRow(l, isNew) {
  var d   = new Date(l.timestamp);
  var ts  = d.toLocaleString('en-GB',{hour12:false,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  var num = String((l.direction==='outbound' ? l.to : l.from) || '').replace('@c.us','');
  var dir = l.direction==='outbound' ? '<span class="b bo">&#8593; Out</span>' : '<span class="b br">&#8595; In</span>';
  var typ = (l.type && l.type!=='text') ? '<span class="b bx">'+esc(l.type)+'</span>' : '<span style="color:var(--muted);font-size:11px">text</span>';
  var st  = l.status==='sent' ? '<span class="b bs">&#10003; Sent</span>' :
            l.status==='received' ? '<span class="b br">&#10003; Recv</span>' :
            '<span class="b bf">&#10007; Failed</span>';
  var err = l.error ? '<div style="color:var(--danger);font-size:11px;margin-top:2px">'+esc(l.error)+'</div>' : '';
  return '<tr'+(isNew?' class="nr"':'')+'>' +
    '<td class="mono" style="white-space:nowrap;color:var(--muted)">'+ts+'</td>' +
    '<td>'+dir+'</td><td class="mono">'+esc(num)+'</td><td>'+typ+'</td>' +
    '<td>'+esc(l.body)+err+'</td><td>'+st+'</td></tr>';
}

// ── SSE live updates ───
var sse = null;
function startSSE() {
  if (sse) { sse.close(); sse = null; }
  var es = sse = new EventSource('/api/logs-stream');
  var pill = document.getElementById('live-pill');
  es.onmessage = function(e) {
    var log = JSON.parse(e.data);
    LOGS.unshift(log);
    if (LOGS.length > 100) LOGS.pop();
    renderStats();
    var body = document.getElementById('log-body');
    if (body) {
      body.insertAdjacentHTML('afterbegin', logRow(log, true));
      if (body.rows.length > 100) body.deleteRow(body.rows.length-1);
    } else {
      renderLogs();
    }
    toast(log.direction==='inbound' ? '&#128232; New message' : (log.status==='failed' ? '&#10007; Message failed' : '&#10003; Message sent'));
  };
  es.onerror   = function(){ if(pill) pill.style.opacity='.4'; es.close(); if (sse === es) { sse = null; setTimeout(startSSE, 3000); } };
  es.onopen    = function(){ if(pill) pill.style.opacity='1'; };
}

// ── playground 
function renderPlayground() {
  document.getElementById('p-playground').innerHTML =
    '<div class="card">' +
      '<div class="ct">Send a Test Message</div>' +
      '<label>To (phone number)</label>' +
      '<input class="fi" id="pg-to" type="tel" placeholder="8801711000000 or 8937@lid"/>' +
      '<label>Message</label>' +
      '<textarea class="fi" id="pg-msg" placeholder="Type your message..."></textarea>' +
      '<div class="row"><button class="btn" onclick="pgsend()">Send &#8599;</button>' +
      '<button class="btn btn-g btn-s" onclick="document.getElementById(\'pg-r\').className=\'pr\';document.getElementById(\'pg-r\').textContent=\'Ready.\'">Clear</button></div>' +
      '<div class="pr" id="pg-r">Results will appear here...</div>' +
    '</div>';
}

async function pgsend() {
  var to  = document.getElementById('pg-to').value.trim();
  var msg = document.getElementById('pg-msg').value.trim();
  var el  = document.getElementById('pg-r');
  if (!to||!msg){ el.textContent='Fill in both fields.'; el.className='pr er'; return; }
  el.className='pr'; el.textContent='Sending...';
  try {
    var r = await fetch('/send?clientid='+encodeURIComponent(CID)+'&key='+encodeURIComponent(KEY)+'&to='+encodeURIComponent(to),
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    var d = await r.json();
    if(r.ok){ el.className='pr ok'; el.textContent='Sent!\n\n'+JSON.stringify(d,null,2); }
    else    { el.className='pr er'; el.textContent='Failed:\n\n'+JSON.stringify(d,null,2); }
  } catch(e){ el.className='pr er'; el.textContent='Error: '+e.message; }
}

// ── webhooks 
function renderWebhooks() {
  var h = '<div class="card" style="margin-bottom:16px">' +
    '<div class="ct">Add Webhook</div>' +
    '<p style="font-size:13px;color:var(--muted);margin-bottom:14px;line-height:1.6">Get notified on every inbound message. Works with query params like <code style="color:var(--green)">?key=abc</code> too.</p>' +
    '<label>URL</label><input class="fi" id="wh-url" type="url" placeholder="https://yoursite.com/webhook"/>' +
    '<div class="row" style="margin-bottom:12px">' +
      '<div style="flex:1"><label>Method</label><select class="fi" id="wh-m" style="margin-bottom:0"><option>POST</option><option>GET</option></select></div>' +
      '<div style="flex:2"><label>Label</label><input class="fi" id="wh-l" placeholder="My CRM" style="margin-bottom:0"/></div>' +
    '</div>' +
    '<button class="btn" onclick="addWH()">Add Webhook</button>' +
  '</div>' +
  '<div class="card"><div class="ct">Active Webhooks</div><div id="wh-list">';

  if (!HOOKS.length) {
    h += '<div class="empty">No webhooks yet.</div>';
  } else {
    HOOKS.forEach(function(w) {
      h += '<div class="wi">' +
        '<div><div class="wu">'+esc(w.url)+'</div><div class="wm">'+esc(w.method)+' &middot; '+esc(w.label||'No label')+' &middot; '+(w.active?'Active':'Paused')+'</div></div>' +
        '<button class="btn btn-g btn-s" onclick="toggleWH(\''+w._id+'\','+(!w.active)+')">'+(w.active?'Pause':'Resume')+'</button>' +
        '<button class="btn btn-d btn-s" onclick="delWH(\''+w._id+'\')">Delete</button>' +
      '</div>';
    });
  }
  h += '</div></div>';
  document.getElementById('p-webhooks').innerHTML = h;
}

async function addWH() {
  var url = document.getElementById('wh-url').value.trim();
  var m   = document.getElementById('wh-m').value;
  var l   = document.getElementById('wh-l').value.trim();
  if (!url) return toast('URL required');
  var r = await fetch('/webhooks',{method:'POST',headers:{'Content-Type':'application/json','x-client-id':CID,'x-api-key':KEY},body:JSON.stringify({url:url,method:m,label:l})});
  var d = await r.json();
  if (r.ok) { HOOKS = d.webhooks; renderWebhooks(); toast('Webhook added!'); }
}
async function delWH(id) {
  var r = await fetch('/webhooks/'+id,{method:'DELETE',headers:{'x-client-id':CID,'x-api-key':KEY}});
  var d = await r.json();
  if (r.ok) { HOOKS = d.webhooks; renderWebhooks(); toast('Removed'); }
}
async function toggleWH(id, active) {
  await fetch('/webhooks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','x-client-id':CID,'x-api-key':KEY},body:JSON.stringify({active:active})});
  var r = await fetch('/api/me'); var d = await r.json(); HOOKS = d.webhooks; renderWebhooks();
  toast(active ? 'Resumed' : 'Paused');
}

// ── examples 
function renderExamples() {
  var curl = 'curl -X POST "https://wpsent.xyz/send?clientid='+CID+'&key=YOUR_KEY&to=8801711000000" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"message": "Hello!"}\'';
  var node = 'const res = await fetch(\n  \'https://wpsent.xyz/send?clientid='+CID+'&key=YOUR_KEY&to=8801711000000\',\n  { method:\'POST\', headers:{\'Content-Type\':\'application/json\'},\n    body: JSON.stringify({ message: \'Hello!\' }) }\n);\nconsole.log(await res.json());';
  var py   = 'import requests\nr = requests.post(\'https://wpsent.xyz/send\',\n    params={\'clientid\':\''+CID+'\',\'key\':\'YOUR_KEY\',\'to\':\'8801711000000\'},\n    json={\'message\': \'Hello!\'})\nprint(r.json())';

  document.getElementById('p-examples').innerHTML =
    '<div class="card">' +
      '<div class="ct">Code Examples</div>' +
      '<div class="lt">' +
        '<div class="ltb on" id="lt-curl" onclick="sl(this,\'lp-curl\')">cURL</div>' +
        '<div class="ltb" id="lt-node" onclick="sl(this,\'lp-node\')">Node.js</div>' +
        '<div class="ltb" id="lt-py"   onclick="sl(this,\'lp-py\')">Python</div>' +
      '</div>' +
      '<div id="lp-curl"><div class="cb" id="cb-curl">'+esc(curl)+'<button class="cp" onclick="cpc(\'cb-curl\')">copy</button></div></div>' +
      '<div id="lp-node" style="display:none"><div class="cb" id="cb-node">'+esc(node)+'<button class="cp" onclick="cpc(\'cb-node\')">copy</button></div></div>' +
      '<div id="lp-py"   style="display:none"><div class="cb" id="cb-py">'+esc(py)+'<button class="cp" onclick="cpc(\'cb-py\')">copy</button></div></div>' +
      '<p style="font-size:12px;color:var(--muted);margin-top:14px"><a href="/docs" style="color:var(--green);text-decoration:none">Full API docs &rarr;</a></p>' +
    '</div>';
}

// ── UI helpers 
function sw(name) {
  ['logs','playground','webhooks','examples'].forEach(function(n) {
    document.getElementById('t-'+n).classList.toggle('on', n===name);
    document.getElementById('p-'+n).classList.toggle('on', n===name);
  });
}

function sl(el, panel) {
  el.closest('.card').querySelectorAll('.ltb').forEach(function(b){ b.classList.remove('on'); });
  el.classList.add('on');
  el.closest('.card').querySelectorAll('[id^="lp-"]').forEach(function(p){ p.style.display='none'; });
  document.getElementById(panel).style.display = 'block';
}

function cpc(id) {
  var el = document.getElementById(id);
  var clone = el.cloneNode(true);
  var b = clone.querySelector('.cp'); if (b) b.remove();
  var text = clone.textContent.trim();
  cp(text, 'Code');
}

function cp(text, label) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){ toast(label+' copied!'); }, function(){ toast('Copy failed'); });
  } else {
    var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast(label+' copied!'); } catch(e) { toast('Copy failed'); }
    t.remove();
  }
}

function toast(msg) {
  var t = document.getElementById('toast');
  t.innerHTML = msg; t.classList.add('on');
  setTimeout(function(){ t.classList.remove('on'); }, 2500);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

boot();
</script>
</body>
</html>`;
}


function docsHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WPSent API Docs</title>
<meta name="description" content="WPSent API documentation - send WhatsApp messages, webhooks, authentication guide."/>
<meta name="robots" content="index, follow"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%2325d366'/><polygon points='14,30 50,18 42,46 28,32' fill='%230d0d0d'/></svg>"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0d0d0d;--surf:#161616;--surf2:#1f1f1f;--border:#2a2a2a;
  --green:#25d366;--text:#e8e8e8;--muted:#666;--danger:#e74c3c;--blue:#3498db;--r:12px;--rs:8px;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;line-height:1.6;}
.nav{display:flex;align-items:center;justify-content:space-between;padding:13px 24px;
  border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;
  background:rgba(13,13,13,.95);backdrop-filter:blur(10px);}
.nav-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;text-decoration:none;color:var(--text);}
.nav-icon{width:28px;height:28px;background:var(--green);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;}
.nav-links{display:flex;gap:6px;}
.nav-link{font-size:12px;color:var(--muted);text-decoration:none;padding:5px 11px;border-radius:20px;border:1px solid transparent;transition:all .15s;}
.nav-link:hover,.nav-link.on{color:var(--text);border-color:var(--border);}
.nav-link.gh{background:var(--surf2);border-color:var(--border);color:var(--text);display:flex;align-items:center;gap:5px;}
.layout{display:grid;grid-template-columns:210px 1fr;max-width:1080px;margin:0 auto;}
.sb{padding:24px 16px;border-right:1px solid var(--border);position:sticky;top:57px;height:calc(100vh - 57px);overflow-y:auto;}
.sb h3{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:600;margin-bottom:8px;margin-top:18px;}
.sb h3:first-child{margin-top:0;}
.sb a{display:block;font-size:13px;color:var(--muted);text-decoration:none;padding:4px 8px;border-radius:6px;margin-bottom:2px;}
.sb a:hover{color:var(--text);background:var(--surf2);}
.doc{padding:36px 44px;max-width:740px;}
h1{font-size:26px;font-weight:700;margin-bottom:8px;}
h2{font-size:17px;font-weight:600;margin:36px 0 10px;padding-top:18px;border-top:1px solid var(--border);}
h2:first-of-type{border-top:none;margin-top:16px;}
h3{font-size:14px;font-weight:600;margin:18px 0 7px;}
p{font-size:14px;color:#bbb;margin-bottom:10px;}
code{font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--surf2);padding:2px 6px;border-radius:4px;color:var(--green);}
pre{background:var(--surf2);border:1px solid var(--border);border-radius:var(--rs);padding:14px;
  font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.7;overflow-x:auto;margin-bottom:14px;color:#aaa;}
.mt{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;margin-right:6px;font-family:'JetBrains Mono',monospace;}
.get{background:#1a2a3a;color:var(--blue);}
.post{background:#1a3a26;color:var(--green);}
.del{background:#3a1a1a;color:var(--danger);}
.ptch{background:#2a2010;color:#f39c12;}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px;}
th{text-align:left;padding:7px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);border-bottom:1px solid var(--border);}
td{padding:9px 10px;border-bottom:1px solid var(--surf2);color:#bbb;}
td:first-child{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--green);}
.req{display:inline-block;font-size:10px;padding:1px 6px;border-radius:10px;background:#3a1a1a;color:var(--danger);font-weight:600;margin-left:4px;}
.cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:16px 0;}
.card{background:var(--surf);border:1px solid var(--border);border-radius:var(--rs);padding:12px;}
.card .icon{font-size:18px;margin-bottom:6px;}
.card h4{font-size:13px;font-weight:600;margin-bottom:3px;}
.card p{font-size:12px;color:var(--muted);margin:0;}
@media(max-width:700px){.layout{grid-template-columns:1fr;}.sb{display:none;}.doc{padding:20px;}}
</style>
</head>
<body>
<nav class="nav">
  <a class="nav-logo" href="/"><div class="nav-icon">💬</div>WPSent</a>
  <div class="nav-links">
    <a class="nav-link on" href="/docs">Docs</a>
    <a class="nav-link gh" href="${CONFIG.GITHUB_URL}" target="_blank">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
      GitHub
    </a>
    <a class="nav-link" href="/">Sign In</a>
  </div>
</nav>
<div class="layout">
  <div class="sb">
    <h3>Getting Started</h3>
    <a href="#intro">Introduction</a>
    <a href="#auth">Authentication</a>
    <a href="#self-host">Self-Hosting</a>
    <h3>API Reference</h3>
    <a href="#send">Send Message</a>
    <a href="#logs">Message Logs</a>
    <a href="#status">Status</a>
    <a href="#webhooks">Webhooks</a>
    <h3>Guides</h3>
    <a href="#examples">Code Examples</a>
    <a href="#types">Message Types</a>
    <a href="#contact">Contact</a>
  </div>
  <div class="doc">
    <h1 id="intro">WPSent API Docs</h1>
    <p>WPSent is a self-hosted WhatsApp API gateway. Link your number once, get a Client ID and Secret Key, then send and receive messages via REST API.</p>
    <div class="cards">
      <div class="card"><div class="icon">&#9889;</div><h4>REST API</h4><p>Simple HTTP, any language</p></div>
      <div class="card"><div class="icon">&#128279;</div><h4>Webhooks</h4><p>Receive inbound messages</p></div>
      <div class="card"><div class="icon">&#128994;</div><h4>No fees</h4><p>Self-hosted, always free</p></div>
    </div>

    <h2 id="auth">Authentication</h2>
    <p>Every API request requires two credentials:</p>
    <table>
      <thead><tr><th>Credential</th><th>Query param</th><th>Header</th></tr></thead>
      <tbody>
        <tr><td>clientid</td><td><code>?clientid=</code></td><td><code>x-client-id</code></td></tr>
        <tr><td>key</td><td><code>?key=</code></td><td><code>x-api-key</code></td></tr>
      </tbody>
    </table>
    <p>Your Secret Key is also your dashboard login password. Find both on your dashboard after scanning the QR code.</p>

    <h2 id="self-host">Self-Hosting</h2>
    <h3>Railway (recommended)</h3>
    <pre>1. Fork: ${CONFIG.GITHUB_URL}
2. New project on railway.app &rarr; Deploy from GitHub
3. Add env var: MONGO_URI = your MongoDB Atlas URI
4. Add env var: SINGLE_USER = true  (optional, limits to 1 user)
5. Deploy &mdash; Chromium installs automatically</pre>
    <h3>Local</h3>
    <pre>git clone ${CONFIG.GITHUB_URL}
cd wpsent
cp .env.example .env   # add MONGO_URI
npm install
npm start              # visit http://localhost:3000</pre>

    <h2 id="send">Send a Message</h2>
    <p><span class="mt post">POST</span><code>/send</code></p>
    <table>
      <thead><tr><th>Param</th><th>Where</th><th>Notes</th></tr></thead>
      <tbody>
        <tr><td>clientid<span class="req">required</span></td><td>query or header</td><td>Your client ID</td></tr>
        <tr><td>key<span class="req">required</span></td><td>query or header</td><td>Your secret key</td></tr>
        <tr><td>to<span class="req">required</span></td><td>query or body</td><td>Phone number. + and spaces accepted. @lid and @g.us passed as-is.</td></tr>
        <tr><td>message<span class="req">required</span></td><td>JSON body</td><td>Message text</td></tr>
      </tbody>
    </table>
    <pre>curl -X POST "https://wpsent.xyz/send?clientid=YOUR_CID&key=YOUR_KEY&to=8801711000000" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello!"}'

// Response
{ "ok": true, "logId": "64f3a..." }</pre>

    <h2 id="logs">Message Logs</h2>
    <p><span class="mt get">GET</span><code>/logs</code> &mdash; last 100 messages, oldest auto-deleted.</p>
    <pre>curl "https://wpsent.xyz/logs?clientid=YOUR_CID&key=YOUR_KEY"</pre>

    <h2 id="status">Connection Status</h2>
    <p><span class="mt get">GET</span><code>/status</code></p>
    <pre>{ "phone": "8801711000000", "status": "ready" }
// status values: initializing | qr_ready | ready | disconnected | auth_failure | error</pre>

    <h2 id="webhooks">Webhooks</h2>
    <p>Add URLs to receive a request on every inbound message. Query params in your URL are preserved.</p>
    <h3>Add</h3>
    <pre>POST /webhooks
x-client-id: YOUR_CID
x-api-key: YOUR_KEY
{ "url": "https://yoursite.com/hook?key=abc", "method": "POST", "label": "My CRM" }</pre>
    <h3>Toggle / Delete</h3>
    <pre><span class="mt ptch">PATCH</span> /webhooks/:id  { "active": false }
<span class="mt del">DELETE</span> /webhooks/:id</pre>
    <h3>Payload</h3>
    <pre>{
  "event":     "message_received",
  "from":      "8801711000000",
  "body":      "Hello!",
  "type":      "text",
  "timestamp": "2024-01-01T10:30:00.000Z"
}</pre>

    <h2 id="examples">Code Examples</h2>
    <h3>Node.js</h3>
    <pre>const res = await fetch(
  'https://wpsent.xyz/send?clientid=YOUR_CID&key=YOUR_KEY&to=8801711000000',
  { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ message: 'Hello!' }) }
);
console.log(await res.json());</pre>
    <h3>Python</h3>
    <pre>import requests
r = requests.post('https://wpsent.xyz/send',
    params={'clientid':'YOUR_CID','key':'YOUR_KEY','to':'8801711000000'},
    json={'message': 'Hello!'})
print(r.json())</pre>
    <h3>Webhook receiver (Flask)</h3>
    <pre>from flask import Flask, request
app = Flask(__name__)
@app.route('/hook', methods=['POST'])
def hook():
    d = request.json
    print(f"{d['from']}: {d['body']} ({d['type']})")
    return {'ok': True}
app.run(port=5000)</pre>

    <h2 id="types">Message Types</h2>
    <table>
      <thead><tr><th>type</th><th>body value</th></tr></thead>
      <tbody>
        <tr><td>text</td><td>The message text</td></tr>
        <tr><td>reaction</td><td>[Reaction: &#128077;]</td></tr>
        <tr><td>sticker</td><td>[Sticker]</td></tr>
        <tr><td>image</td><td>[Image] or caption</td></tr>
        <tr><td>video</td><td>[Video]</td></tr>
        <tr><td>audio</td><td>[Audio]</td></tr>
        <tr><td>document</td><td>[Document: filename]</td></tr>
        <tr><td>location</td><td>[Location: lat,lng]</td></tr>
        <tr><td>contact</td><td>[Contact card]</td></tr>
      </tbody>
    </table>

    <h2 id="contact">Contact &amp; Support</h2>
    <p>Need help setting up your own instance?</p>
    <p>&#128247; Instagram: <a href="${CONFIG.INSTAGRAM_URL}" target="_blank" style="color:var(--green)">${CONFIG.INSTAGRAM_URL}</a></p>
    <p>&#128140; Email: <a href="mailto:${CONFIG.EMAIL}" style="color:var(--green)">${CONFIG.EMAIL}</a></p>
    <p>&#128196; GitHub: <a href="${CONFIG.GITHUB_URL}" target="_blank" style="color:var(--green)">${CONFIG.GITHUB_URL}</a></p>
  </div>
</div>
</body>
</html>`;
}
