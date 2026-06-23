
require('dotenv').config();

process.on('uncaughtException', (err) => {
  if (
    err?.code === 'ENOENT' ||
    err?.message?.includes('Target closed') ||
    err?.message?.includes('TargetCloseError') ||
    err?.message?.includes('Session closed') ||
    err?.message?.includes('Protocol error')
  ) {
    console.error('[WARN] Recoverable error caught (session issue):', err.message);
    return; // don't crash
  }
  // Real unknown error — log it but still don't crash
  console.error('[ERROR] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection:', reason?.message || reason);
});
const express      = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const wa       = require('./waManager');
const routes   = require('./routes');

const app      = express();
const PORT     = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('  MONGO_URI is not set. Add it to your .env file.');
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/', routes);
app.use(express.static('public'));
async function start() {
  try {
    await mongoose.connect(MONGO_URI, { dbName: 'wa_gateway' });
    console.log('  MongoDB connected');
    console.log('  WhatsApp sessions will be stored in MongoDB (no local files)');

    await wa.restoreAllSessions();

    app.listen(PORT, () => {
      console.log(`\n  WPSent running → http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
}

start();
