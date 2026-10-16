const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  url:    { type: String, required: true },
  method: { type: String, enum: ['GET', 'POST'], default: 'POST' },
  label:  { type: String, default: '' },
  active: { type: Boolean, default: true }
});

const wpUserSchema = new mongoose.Schema({
  phone:         { type: String, required: true, unique: true, index: true },
  clientId:      { type: String, required: true, unique: true, index: true },
  apiKey:        { type: String, required: true },
  loginAttempts: { type: Number, default: 0 },
  lockedUntil:   { type: Date, default: null },
  lastSeen:      { type: Date, default: null },
  sessionData:   { type: mongoose.Schema.Types.Mixed, default: null },
  webhooks:      { type: [webhookSchema], default: [] }
}, { timestamps: true });

const messageLogSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'WpUser', required: true, index: true },
  direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  from:      { type: String, default: null },
  to:        { type: String, default: null },
  body:      { type: String, default: '' },
  type:      { type: String, default: 'text' },
  status:    { type: String, default: 'sent' },
  error:     { type: String, default: null },
  timestamp: { type: Date, default: Date.now, index: true }
});
messageLogSchema.index({ userId: 1, timestamp: -1 });

const WpUser     = mongoose.models.WpUser     || mongoose.model('WpUser', wpUserSchema);
const MessageLog = mongoose.models.MessageLog || mongoose.model('MessageLog', messageLogSchema);

module.exports = { WpUser, MessageLog };
