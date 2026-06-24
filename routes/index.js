const express  = require('express');
const router   = express.Router();
const qrcode   = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { WpUser, MessageLog } = require('../models');
const wa = require('../waManager');

//  helpers 
function genClientId() {
  return 'cid_' + Math.random().toString(36).slice(2, 8);
}

//  API key middleware (for REST API calls) 
async function requireKey(req, res, next) {
  const clientId = req.query.clientid || req.headers['x-client-id'];
  const key      = req.query.key      || req.headers['x-api-key'];
  if (!clientId) return res.status(401).json({ error: 'Missing clientid' });
  if (!key)      return res.status(401).json({ error: 'Missing key' });
  const user = await WpUser.findOne({ clientId });
  if (!user)               return res.status(403).json({ error: 'Unknown client ID' });
  if (user.apiKey !== key) return res.status(403).json({ error: 'Invalid API key' });
  req.wpUser = user;
  next();
}


async function requireDashboard(req, res, next) {
  const phone = wa.sanitizePhone(req.query.phone || req.cookies?.wpsent_phone || '');
  if (!phone) return res.redirect('/');
  const user = await WpUser.findOne({ phone });
  if (!user)  return res.redirect('/');

  
  const status = wa.getStatus(phone);
  if (status === 'not_started') {
  
    wa.createSession(phone);
  }

 
  res.cookie('wpsent_phone', phone, {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax'
  });

  req.wpPhone = phone;
  req.wpUser  = user;
  next();
}


router.get('/', (req, res) => res.send(landingHTML()));


router.post('/auth/start', async (req, res) => {
  const phone = wa.sanitizePhone(req.body.phone || '');
  if (!phone) return res.status(400).json({ error: 'phone required' });
  let user = await WpUser.findOne({ phone });
  if (!user) {
    user = await WpUser.create({ phone, clientId: genClientId(), apiKey: uuidv4() });
  }
  wa.createSession(phone);
  res.json({ ok: true, phone });
});


router.get('/auth/qr-stream', async (req, res) => {
  const phone = wa.sanitizePhone(req.query.phone || '');
  if (!phone) return res.status(400).end('phone required');

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (wa.getStatus(phone) === 'ready') { send('ready', { phone }); return res.end(); }

  const session = wa.getSession(phone);
  if (session?.qr) {
    const dataUrl = await qrcode.toDataURL(session.qr, { width: 300 });
    send('qr', { dataUrl });
  }

  const onQR = async (qr) => {
    const dataUrl = await qrcode.toDataURL(qr, { width: 300 });
    send('qr', { dataUrl });
  };
  wa.onQR(phone, onQR);

  const timer = setInterval(() => {
    if (wa.getStatus(phone) === 'ready') {
      send('ready', { phone });
      clearInterval(timer);
      wa.offQR(phone, onQR);
      res.end();
    }
  }, 2000);

  req.on('close', () => { clearInterval(timer); wa.offQR(phone, onQR); });
});


router.get('/dashboard', requireDashboard, async (req, res) => {
  const logs = await MessageLog.find({ userId: req.wpUser._id })
    .sort({ timestamp: -1 }).limit(100);
  res.send(dashboardHTML(req.wpUser, logs));
});


router.get('/logout', (req, res) => {
  res.clearCookie('wpsent_phone');
  res.redirect('/');
});


router.get('/api/logs-stream', requireDashboard, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);


  wa.onLog(req.wpUser._id.toString(), send);


  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch (_) {}
  }, 10000);

  req.on('close', () => {
    clearInterval(heartbeat);
    wa.offLog(req.wpUser._id.toString(), send);
  });
});


router.post('/send', requireKey, async (req, res) => {
    const rawTo   = req.query.to || req.body.to || '';
    const to = rawTo.includes('@') ? rawTo : wa.sanitizePhone(rawTo);

  const message = req.body.message || req.body.body || req.query.message || '';
  if (!to)      return res.status(400).json({ error: '`to` phone number required' });
  if (!message) return res.status(400).json({ error: '`message` body required' });

  let status = 'sent', error = null;
  try {
    await wa.sendMessage(req.wpUser.phone, to, message);
  } catch (e) {
    status = 'failed';
    error  = e.message;
  }

  const log = await MessageLog.create({
    userId: req.wpUser._id, direction: 'outbound',
    to, body: message, type: 'text', status, error
  });
  await wa.pruneOldLogs(req.wpUser._id);


  wa.emitLog(req.wpUser._id.toString(), log.toObject());

  if (status === 'failed') return res.status(500).json({ error, logId: log._id });
  res.json({ ok: true, logId: log._id });
});


router.get('/logs', requireKey, async (req, res) => {
  const logs = await MessageLog.find({ userId: req.wpUser._id })
    .sort({ timestamp: -1 }).limit(100);
  res.json(logs);
});


router.get('/status', requireKey, async (req, res) => {
  res.json({ phone: req.wpUser.phone, status: wa.getStatus(req.wpUser.phone) });
});


router.post('/webhooks', requireKey, async (req, res) => {
  const { url, method = 'POST', label = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const user = await WpUser.findByIdAndUpdate(
    req.wpUser._id,
    { $push: { webhooks: { url, method, label } } },
    { returnDocument: 'after' }
  );
  res.json({ ok: true, webhooks: user.webhooks });
});

router.delete('/webhooks/:id', requireKey, async (req, res) => {
  const user = await WpUser.findByIdAndUpdate(
    req.wpUser._id,
    { $pull: { webhooks: { _id: req.params.id } } },
    { returnDocument: 'after' }
  );
  res.json({ ok: true, webhooks: user.webhooks });
});

router.patch('/webhooks/:id', requireKey, async (req, res) => {
  const { active } = req.body;
  await WpUser.updateOne(
    { _id: req.wpUser._id, 'webhooks._id': req.params.id },
    { $set: { 'webhooks.$.active': active } }
  );
  res.json({ ok: true });
});

module.exports = router;


function landingHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="index, follow"/>
<meta name="googlebot" content="index, follow"/>
<meta name="keywords" content="WhatsApp API, WhatsApp gateway, WhatsApp bot, send WhatsApp message API, self-hosted WhatsApp, WhatsApp webhook, WhatsApp REST API, WPSent, whatsapp-web.js, WhatsApp automation"/>
<!-- Primary meta -->
<title>WPSent · WhatsApp API Gateway</title>
<meta name="description" content="Open-Source WhatsApp API gateway. Send messages, receive webhooks, and manage multiple accounts via REST API."/>
<meta name="theme-color" content="#25d366"/>

<!-- Open Graph (WhatsApp, Facebook, LinkedIn previews) -->
<meta property="og:type" content="website"/>
<meta property="og:title" content="WPSent · WhatsApp API Gateway"/>
<meta property="og:description" content="Open-Source WhatsApp API gateway. Send messages, receive webhooks, and manage multiple accounts via REST API."/>
<meta property="og:image" content="/og-image.png"/>
<meta property="og:url" content="https://wpsent.xyz"/>

<!-- Twitter card -->
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="WPSent · WhatsApp API Gateway"/>
<meta name="twitter:description" content="Open-Source WhatsApp API gateway. Send messages, receive webhooks, and manage multiple accounts via REST API."/>
<meta name="twitter:image" content="/og-image.png"/>

<!-- Favicon — SVG (best, works everywhere modern) -->
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<!-- Fallback for older browsers -->
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
<link rel="apple-touch-icon" sizes="180x180" href="/favicon-180.png"/>

<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d0d0d;--surface:#161616;--surface2:#1f1f1f;--border:#2a2a2a;
--green:#25d366;--green-dim:#1a9e4a;--text:#e8e8e8;--muted:#666;--radius:12px;--radius-sm:8px;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;
min-height:100vh;display:flex;align-items:center;justify-content:center;}
.wrap{width:100%;max-width:460px;padding:24px;}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:40px;}
.logo-icon{width:44px;height:44px;background:var(--green);border-radius:12px;
display:flex;align-items:center;justify-content:center;font-size:22px;}
.logo-text{font-size:20px;font-weight:700;}
.logo-sub{font-size:12px;color:var(--muted);margin-top:2px;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px;}
h2{font-size:18px;font-weight:600;margin-bottom:6px;}
p.hint{font-size:13px;color:var(--muted);margin-bottom:24px;line-height:1.6;}
label{font-size:12px;font-weight:500;color:var(--muted);letter-spacing:.5px;
text-transform:uppercase;display:block;margin-bottom:8px;}
input{width:100%;background:var(--surface2);border:1px solid var(--border);
border-radius:var(--radius-sm);padding:12px 14px;color:var(--text);font-size:15px;
font-family:'JetBrains Mono',monospace;outline:none;transition:border-color .15s;}
input:focus{border-color:var(--green);}
button{width:100%;background:var(--green);color:#000;font-weight:600;font-size:14px;
border:none;border-radius:var(--radius-sm);padding:13px;cursor:pointer;margin-top:16px;transition:opacity .15s;}
button:hover{opacity:.88;}
#qr-section{display:none;margin-top:28px;text-align:center;}
#qr-box{background:#fff;border-radius:var(--radius);padding:16px;display:inline-block;}
#qr-box img{display:block;width:240px;height:240px;}
.status-row{display:flex;align-items:center;gap:8px;justify-content:center;
margin-top:14px;font-size:13px;color:var(--muted);}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);
animation:pulse 1.2s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.note{font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5;}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">
    <div class="logo-icon">💬</div>
    <div><div class="logo-text">WPSent</div><div class="logo-sub">WhatsApp API Gateway</div></div>
  </div>
  <div class="card">
    <h2>Connect your WhatsApp</h2>
    <p class="hint">Enter your phone number in international format. Scan the QR code to link your account.</p>
    <div id="step-phone">
      <label>Phone number</label>
      <input id="phone" type="tel" placeholder="+880 1XXX XXX XXX" autocomplete="off"/>
      <p class="note">+, spaces, dashes are all fine — we clean it automatically.</p>
      <button onclick="startAuth()">Continue →</button>
    </div>
    <div id="qr-section">
      <div class="status-row" id="status-msg"><div class="dot"></div> Starting WhatsApp engine…</div>
      <div id="qr-box" style="display:none"><img id="qr-img" src="" alt="QR Code"/></div>
      <p class="note">Open WhatsApp → Linked Devices → Link a Device → point camera here</p>
    </div>
  </div>
</div>
<script>
let phone='';
async function startAuth(){
  phone=document.getElementById('phone').value.trim();
  if(!phone)return;
  document.getElementById('step-phone').style.display='none';
  document.getElementById('qr-section').style.display='block';
  await fetch('/auth/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});
  const es=new EventSource('/auth/qr-stream?phone='+encodeURIComponent(phone));
  es.addEventListener('qr',e=>{
    const{dataUrl}=JSON.parse(e.data);
    document.getElementById('qr-img').src=dataUrl;
    document.getElementById('qr-box').style.display='inline-block';
    document.getElementById('status-msg').innerHTML='<div class="dot"></div> Scan with your phone';
  });
  es.addEventListener('ready',()=>{
    es.close();
    document.getElementById('status-msg').innerHTML=' Connected! Redirecting…';
    document.getElementById('qr-box').style.display='none';
    setTimeout(()=>{window.location.href='/dashboard?phone='+encodeURIComponent(phone);},1200);
  });
  es.onerror=()=>{document.getElementById('status-msg').textContent=' Error. Refresh to retry.';};
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('phone').addEventListener('keydown',e=>{if(e.key==='Enter')startAuth();});
});
</script>
</body></html>`;
}


function dashboardHTML(user, logs) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WPSent · Dashboard</title>
<meta name="robots" content="noindex, nofollow"/>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d0d0d;--surface:#161616;--surface2:#1f1f1f;--border:#2a2a2a;
--green:#25d366;--green-dim:#1a9e4a;--text:#e8e8e8;--muted:#666;
--danger:#e74c3c;--warn:#f39c12;--blue:#3498db;--purple:#9b59b6;
--radius:12px;--radius-sm:8px;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;min-height:100vh;}
.topbar{display:flex;align-items:center;justify-content:space-between;
padding:14px 28px;border-bottom:1px solid var(--border);position:sticky;top:0;
background:rgba(13,13,13,.92);backdrop-filter:blur(10px);z-index:100;}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;}
.logo-icon{width:32px;height:32px;background:var(--green);border-radius:8px;
display:flex;align-items:center;justify-content:center;font-size:16px;}
.topbar-right{display:flex;align-items:center;gap:10px;}
.status-pill{display:flex;align-items:center;gap:6px;font-size:12px;
background:var(--surface2);border:1px solid var(--border);padding:6px 12px;border-radius:20px;}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);}
.dot.orange{background:var(--warn);}
.live-badge{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
color:var(--green);background:#1a3a26;border:1px solid #2a5a36;padding:5px 10px;border-radius:20px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);
animation:pulse 1s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.logout-btn{font-size:12px;color:var(--muted);background:none;border:1px solid var(--border);
padding:6px 12px;border-radius:20px;cursor:pointer;transition:all .15s;}
.logout-btn:hover{color:var(--text);border-color:var(--muted);}
main{max-width:1140px;margin:0 auto;padding:28px 24px;}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px;}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr);}}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
padding:18px;text-align:center;}
.stat-num{font-size:30px;font-weight:700;color:var(--green);}
.stat-label{font-size:11px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;}
.cred-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px;}
@media(max-width:700px){.cred-grid{grid-template-columns:1fr;}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px;}
.card-title{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:12px;font-weight:600;}
.cred-item{margin-bottom:14px;}
.cred-item:last-child{margin-bottom:0;}
.cred-label{font-size:11px;color:var(--muted);margin-bottom:5px;letter-spacing:.3px;}
.cred-val{font-family:'JetBrains Mono',monospace;font-size:13px;background:var(--surface2);
border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 13px;
color:var(--green);word-break:break-all;cursor:pointer;transition:border-color .15s;
display:flex;align-items:center;justify-content:space-between;gap:8px;}
.cred-val:hover{border-color:var(--green);}
.cred-copy{font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;}
.tabs{display:flex;gap:2px;margin-bottom:20px;border-bottom:1px solid var(--border);}
.tab{padding:10px 18px;font-size:13px;font-weight:500;cursor:pointer;
border-bottom:2px solid transparent;color:var(--muted);transition:all .15s;white-space:nowrap;}
.tab.active{color:var(--text);border-bottom-color:var(--green);}
.tab-panel{display:none;}.tab-panel.active{display:block;}
.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;min-width:600px;}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);
font-weight:600;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);}
td{padding:11px 12px;font-size:13px;border-bottom:1px solid var(--surface2);vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr.new-row{animation:fadeIn .4s ease;}
@keyframes fadeIn{from{background:#1a3a26;opacity:.6}to{background:transparent;opacity:1}}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;
padding:3px 9px;border-radius:20px;white-space:nowrap;}
.b-sent{background:#1a3a26;color:var(--green);}
.b-failed{background:#3a1a1a;color:var(--danger);}
.b-received{background:#1a2a3a;color:var(--blue);}
.b-reaction{background:#2a1a3a;color:var(--purple);}
.b-out{background:#2a2010;color:var(--warn);}
.mono{font-family:'JetBrains Mono',monospace;font-size:12px;}
.empty{text-align:center;padding:48px 20px;color:var(--muted);}
.empty-icon{font-size:36px;margin-bottom:12px;}
label.fl{font-size:12px;font-weight:500;color:var(--muted);letter-spacing:.5px;
text-transform:uppercase;display:block;margin-bottom:6px;}
input.fi,select.fi,textarea.fi{width:100%;background:var(--surface2);border:1px solid var(--border);
border-radius:var(--radius-sm);padding:10px 12px;color:var(--text);font-size:13px;
font-family:inherit;outline:none;margin-bottom:14px;}
input.fi:focus,select.fi:focus,textarea.fi:focus{border-color:var(--green);}
textarea.fi{resize:vertical;min-height:80px;}
.btn{background:var(--green);color:#000;font-weight:600;font-size:13px;
border:none;border-radius:var(--radius-sm);padding:10px 18px;cursor:pointer;transition:opacity .15s;}
.btn:hover{opacity:.85;}
.btn-ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border);}
.btn-danger{background:#3a1a1a;color:var(--danger);border:1px solid #5a2a2a;}
.btn-sm{padding:6px 12px;font-size:12px;}
.row{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;}
.playground-result{background:var(--surface2);border:1px solid var(--border);
border-radius:var(--radius-sm);padding:14px;min-height:60px;font-family:'JetBrains Mono',monospace;
font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--muted);margin-top:14px;}
.playground-result.ok{color:var(--green);border-color:var(--green-dim);}
.playground-result.err{color:var(--danger);border-color:#5a2a2a;}
.code-block{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
padding:16px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.7;
white-space:pre-wrap;word-break:break-all;color:#aaa;margin-bottom:16px;position:relative;}
.code-copy{position:absolute;top:10px;right:10px;background:var(--surface);border:1px solid var(--border);
color:var(--muted);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;font-family:inherit;}
.code-copy:hover{color:var(--text);}
.lang-tabs{display:flex;gap:4px;margin-bottom:12px;}
.lang-tab{padding:6px 14px;font-size:12px;font-weight:500;cursor:pointer;
border-radius:6px 6px 0 0;background:var(--surface2);color:var(--muted);border:1px solid var(--border);border-bottom:none;}
.lang-tab.active{background:var(--surface);color:var(--text);}
.wh-item{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;
padding:12px 0;border-bottom:1px solid var(--surface2);}
.wh-item:last-child{border-bottom:none;}
.wh-url{font-family:'JetBrains Mono',monospace;font-size:12px;word-break:break-all;}
.wh-meta{font-size:11px;color:var(--muted);margin-top:2px;}
.toast{position:fixed;bottom:24px;right:24px;background:#1a3a26;color:var(--green);
border:1px solid var(--green-dim);padding:12px 18px;border-radius:var(--radius-sm);
font-size:13px;font-weight:500;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9999;}
.toast.show{opacity:1;}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo"><div class="logo-icon">💬</div> WPSent</div>
  <div class="topbar-right">
    <div class="live-badge" id="live-badge"><div class="live-dot"></div> LIVE</div>
    <div class="status-pill" id="status-pill"><div class="dot"></div>${user.phone}</div>
    <button class="logout-btn" onclick="window.location='/logout'">Logout</button>
  </div>
</div>

<main>
<div class="stats" id="stats-row"></div>

<div class="cred-grid">
  <div class="card">
    <div class="card-title">🔑 Your Credentials</div>
    <div class="cred-item">
      <div class="cred-label">Client ID <span style="color:var(--blue);font-size:10px">(public identifier)</span></div>
      <div class="cred-val" onclick="copy('${user.clientId}','Client ID')">
        <span>${user.clientId}</span><span class="cred-copy">click to copy</span>
      </div>
    </div>
    <div class="cred-item">
      <div class="cred-label">API Secret Key <span style="color:var(--danger);font-size:10px">(keep secret)</span></div>
      <div class="cred-val" onclick="copy('${user.apiKey}','API Key')">
        <span id="key-display">${user.apiKey.slice(0,8)}••••••••••••••••••••••••••••</span>
        <span class="cred-copy" onclick="event.stopPropagation();toggleKey()">reveal</span>
      </div>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.6">
      Both credentials required for every API call.
    </p>
  </div>
  <div class="card">
    <div class="card-title">📡 Quick Send</div>
    <div style="font-family:'JetBrains Mono',monospace;font-size:11px;background:var(--surface2);
      border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;color:#aaa;line-height:1.7;word-break:break-all">POST /send?clientid=<span style="color:var(--blue)">${user.clientId}</span>&amp;key=<span style="color:var(--danger)">SECRET</span>&amp;to=<span style="color:var(--green)">880132...</span>
{"message": "Hello!"}</div>
    <p style="font-size:11px;color:var(--muted);margin-top:8px">Phone number: digits only, + is fine too</p>
  </div>
</div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('logs')">📋 Message Logs</div>
  <div class="tab" onclick="switchTab('playground')">🧪 Playground</div>
  <div class="tab" onclick="switchTab('webhooks')">🔗 Webhooks</div>
  <div class="tab" onclick="switchTab('docs')">📖 Code Examples</div>
</div>

<!-- LOGS -->
<div class="tab-panel active" id="panel-logs">
  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Dir</th><th>Number</th><th>Type</th><th>Message</th><th>Status</th></tr></thead>
        <tbody id="log-tbody"></tbody>
      </table>
      <div class="empty" id="log-empty" style="display:none">
        <div class="empty-icon">📭</div>No messages yet.
      </div>
    </div>
  </div>
</div>

<!-- PLAYGROUND -->
<div class="tab-panel" id="panel-playground">
  <div class="card">
    <div class="card-title">🧪 Test Message Sender</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6">Send a test message directly from the dashboard.</p>
    <label class="fl">To (phone number)</label>
    <input class="fi" id="pg-to" type="tel" placeholder="8801711000000"/>
    <label class="fl">Message</label>
    <textarea class="fi" id="pg-msg" placeholder="Type your test message here…"></textarea>
    <div class="row">
      <button class="btn" onclick="playgroundSend()">Send Message ↗</button>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('pg-result').className='playground-result';document.getElementById('pg-result').textContent='Ready.'">Clear</button>
    </div>
    <div class="playground-result" id="pg-result">Results will appear here…</div>
  </div>
</div>

<!-- WEBHOOKS -->
<div class="tab-panel" id="panel-webhooks">
  <div class="card" style="margin-bottom:18px">
    <div class="card-title">Add Webhook</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.6">
      Get notified on every inbound message — text, emoji, reaction, sticker, media, everything.
    </p>
    <label class="fl">Webhook URL</label>
    <input class="fi" id="wh-url" type="url" placeholder="https://yoursite.com/webhook"/>
    <div class="row" style="margin-bottom:14px">
      <div style="flex:1"><label class="fl">Method</label>
        <select class="fi" id="wh-method" style="margin-bottom:0"><option>POST</option><option>GET</option></select></div>
      <div style="flex:2"><label class="fl">Label (optional)</label>
        <input class="fi" id="wh-label" type="text" placeholder="My CRM" style="margin-bottom:0"/></div>
    </div>
    <button class="btn" onclick="addWebhook()">Add Webhook</button>
  </div>
  <div class="card"><div class="card-title">Active Webhooks</div><div id="wh-list"></div></div>
</div>

<!-- DOCS -->
<div class="tab-panel" id="panel-docs">
  <div class="card">
    <div class="card-title">Code Examples</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6">
      Replace <code style="color:var(--blue)">YOUR_CLIENT_ID</code> and <code style="color:var(--danger)">YOUR_SECRET_KEY</code> with your credentials above.
    </p>
    <div class="lang-tabs">
      <div class="lang-tab active" onclick="switchLang('curl')">cURL</div>
      <div class="lang-tab" onclick="switchLang('node')">Node.js</div>
      <div class="lang-tab" onclick="switchLang('python')">Python</div>
    </div>
    <div class="lang-panel" id="lang-curl">
      <div class="code-block" id="curl-send">curl -X POST "http://wpsent.xyz/send?clientid=YOUR_CLIENT_ID&key=YOUR_SECRET_KEY&to=8801711000000" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello!"}'
<button class="code-copy" onclick="copyCode('curl-send')">copy</button></div>
      <div class="code-block" id="curl-logs">curl "http://wpsent.xyz/logs?clientid=YOUR_CLIENT_ID&key=YOUR_SECRET_KEY"
<button class="code-copy" onclick="copyCode('curl-logs')">copy</button></div>
      <div class="code-block" id="curl-wh">curl -X POST "http://wpsent.xyz/webhooks" \\
  -H "Content-Type: application/json" \\
  -H "x-client-id: YOUR_CLIENT_ID" \\
  -H "x-api-key: YOUR_SECRET_KEY" \\
  -d '{"url":"https://yoursite.com/hook","method":"POST","label":"My Hook"}'
<button class="code-copy" onclick="copyCode('curl-wh')">copy</button></div>
    </div>
    <div class="lang-panel" id="lang-node" style="display:none">
      <div class="code-block" id="node-send">const res = await fetch(
  'http://wpsent.xyz/send?clientid=YOUR_CLIENT_ID&key=YOUR_SECRET_KEY&to=8801711000000',
  { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ message: 'Hello!' }) }
);
const data = await res.json();
console.log(data); // { ok: true, logId: '...' }
<button class="code-copy" onclick="copyCode('node-send')">copy</button></div>
    </div>
    <div class="lang-panel" id="lang-python" style="display:none">
      <div class="code-block" id="py-send">import requests
res = requests.post(
    'http://wpsent.xyz/send',
    params={'clientid':'YOUR_CLIENT_ID','key':'YOUR_SECRET_KEY','to':'8801711000000'},
    json={'message': 'Hello!'}
)
print(res.json())
<button class="code-copy" onclick="copyCode('py-send')">copy</button></div>
    </div>
  </div>
</div>
</main>

<div class="toast" id="toast"></div>

<script>
//  initial data baked in at render time 
let LOGS     = ${JSON.stringify(logs)};
const KEY    = '${user.apiKey}';
const CID    = '${user.clientId}';
let WEBHOOKS = ${JSON.stringify(user.webhooks || [])};
let keyVisible = false;

//  stats 
function renderStats() {
  const sent     = LOGS.filter(l => l.status === 'sent').length;
  const failed   = LOGS.filter(l => l.status === 'failed').length;
  const received = LOGS.filter(l => l.status === 'received').length;
  document.getElementById('stats-row').innerHTML = \`
    <div class="stat"><div class="stat-num">\${LOGS.length}</div><div class="stat-label">Total</div></div>
    <div class="stat"><div class="stat-num">\${sent}</div><div class="stat-label">Sent</div></div>
    <div class="stat"><div class="stat-num">\${received}</div><div class="stat-label">Received</div></div>
    <div class="stat"><div class="stat-num">\${failed}</div><div class="stat-label">Failed</div></div>
  \`;
}

//  logs ─
function logRow(l, isNew) {
  const d    = new Date(l.timestamp);
  const time = d.toLocaleString('en-GB',{hour12:false,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const num  = (l.direction==='outbound' ? l.to : l.from || '').replace('@c.us','');
  const dir  = l.direction==='outbound' ? '<span class="badge b-out">↑ Out</span>' : '<span class="badge b-received">↓ In</span>';
  const typeLabel = l.type && l.type!=='text' ? \`<span class="badge b-reaction" style="margin-left:4px">\${l.type}</span>\` : '<span style="color:var(--muted);font-size:11px">text</span>';
  const st   = l.status==='sent' ? '<span class="badge b-sent">✓ Sent</span>'
             : l.status==='received' ? '<span class="badge b-received">✓ Recv</span>'
             : '<span class="badge b-failed">✗ Failed</span>';
  const err  = l.error ? \`<div style="color:var(--danger);font-size:11px;margin-top:3px">\${l.error}</div>\` : '';
  return \`<tr class="\${isNew?'new-row':''}">
    <td class="mono" style="white-space:nowrap;color:var(--muted)">\${time}</td>
    <td>\${dir}</td><td class="mono">\${num}</td><td>\${typeLabel}</td>
    <td>\${l.body}\${err}</td><td>\${st}</td>
  </tr>\`;
}

function renderLogs() {
  const tbody = document.getElementById('log-tbody');
  if (!LOGS.length) { document.getElementById('log-empty').style.display='block'; return; }
  document.getElementById('log-empty').style.display='none';
  tbody.innerHTML = LOGS.map(l => logRow(l, false)).join('');
}

//  FIX 2: SSE live log stream 
function startLiveStream() {
  const es = new EventSource('/api/logs-stream');
  const badge = document.getElementById('live-badge');

  es.onmessage = (e) => {
    const log = JSON.parse(e.data);
    // Prepend new row to LOGS array
    LOGS.unshift(log);
    if (LOGS.length > 100) LOGS.pop();

    // Inject new row at top of table with animation
    const tbody = document.getElementById('log-tbody');
    document.getElementById('log-empty').style.display = 'none';
    tbody.insertAdjacentHTML('afterbegin', logRow(log, true));
    // Remove last row if over 100
    if (tbody.rows.length > 100) tbody.deleteRow(tbody.rows.length - 1);

    renderStats();
    showToast(log.direction === 'inbound' ? '📨 New message received' : ' Message sent');
  };

  es.onerror = () => {
    badge.style.opacity = '0.4';
    // Auto-reconnect after 3s
    setTimeout(startLiveStream, 3000);
  };

  es.onopen = () => { badge.style.opacity = '1'; };
}

//  webhooks 
function renderWebhooks() {
  const el = document.getElementById('wh-list');
  if (!WEBHOOKS.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">🔗</div>No webhooks yet.</div>';
    return;
  }
  el.innerHTML = WEBHOOKS.map(w => \`
    <div class="wh-item">
      <div>
        <div class="wh-url">\${w.url}</div>
        <div class="wh-meta">\${w.method} · \${w.label||'No label'} · \${w.active?'🟢 Active':'🔴 Paused'}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="toggleWebhook('\${w._id}',\${!w.active})">\${w.active?'Pause':'Resume'}</button>
      <button class="btn btn-danger btn-sm" onclick="deleteWebhook('\${w._id}')">Delete</button>
    </div>
  \`).join('');
}

async function addWebhook() {
  const url=document.getElementById('wh-url').value.trim();
  const method=document.getElementById('wh-method').value;
  const label=document.getElementById('wh-label').value.trim();
  if (!url) return showToast('URL is required');
  const r = await fetch('/webhooks',{method:'POST',
    headers:{'Content-Type':'application/json','x-client-id':CID,'x-api-key':KEY},
    body:JSON.stringify({url,method,label})});
  if (r.ok) { showToast('Webhook added!'); setTimeout(()=>location.reload(),900); }
  else showToast('Failed to add webhook');
}

async function deleteWebhook(id) {
  await fetch('/webhooks/'+id,{method:'DELETE',headers:{'x-client-id':CID,'x-api-key':KEY}});
  showToast('Webhook removed'); setTimeout(()=>location.reload(),900);
}

async function toggleWebhook(id,active) {
  await fetch('/webhooks/'+id,{method:'PATCH',
    headers:{'Content-Type':'application/json','x-client-id':CID,'x-api-key':KEY},
    body:JSON.stringify({active})});
  showToast(active?'Webhook resumed':'Webhook paused'); setTimeout(()=>location.reload(),900);
}

//  playground ─
async function playgroundSend() {
  const to=document.getElementById('pg-to').value.trim();
  const msg=document.getElementById('pg-msg').value.trim();
  const el=document.getElementById('pg-result');
  if (!to||!msg){el.textContent='Please fill in both fields.';el.className='playground-result err';return;}
  el.className='playground-result';el.textContent='Sending…';
  try {
    const r = await fetch('/send?clientid='+encodeURIComponent(CID)+'&key='+encodeURIComponent(KEY)+'&to='+encodeURIComponent(to),
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    const data = await r.json();
    if (r.ok){el.className='playground-result ok';el.textContent=' Sent!\\n\\n'+JSON.stringify(data,null,2);}
    else{el.className='playground-result err';el.textContent=' Failed: '+JSON.stringify(data,null,2);}
  } catch(e){el.className='playground-result err';el.textContent=' Network error: '+e.message;}
}

//  ui helpers ─
function switchTab(name) {
  const names=['logs','playground','webhooks','docs'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',names[i]===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
}

function switchLang(lang) {
  document.querySelectorAll('.lang-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.lang-panel').forEach(p=>p.style.display='none');
  event.target.classList.add('active');
  document.getElementById('lang-'+lang).style.display='block';
}

function copyCode(id) {
  const el=document.getElementById(id);
  const text=el.textContent.replace(el.querySelector('.code-copy').textContent,'').trim();
  navigator.clipboard.writeText(text).then(()=>showToast('Copied!'));
}

function copy(text,label){navigator.clipboard.writeText(text).then(()=>showToast(label+' copied!'));}

function toggleKey() {
  keyVisible=!keyVisible;
  document.getElementById('key-display').textContent=keyVisible?KEY:KEY.slice(0,8)+'••••••••••••••••••••••••••••';
}

function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}

renderStats(); renderLogs(); renderWebhooks();
startLiveStream(); // FIX 2: start live updates
</script>
</body></html>`;
}
