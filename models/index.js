const mongoose = require('mongoose');


const wpUserSchema = new mongoose.Schema({
  phone:      { type: String, required: true, unique: true },
  clientId:   { type: String, required: true, unique: true },  // public identifier
  apiKey:     { type: String, required: true, unique: true },  // secret key
  sessionData:{ type: Object, default: null },
  webhooks: [{
    url:        { type: String, required: true },
    method:     { type: String, enum: ['GET','POST'], default: 'POST' },
    label:      { type: String, default: '' },
    active:     { type: Boolean, default: true },
    createdAt:  { type: Date, default: Date.now }
  }],
  createdAt:  { type: Date, default: Date.now },
  lastSeen:   { type: Date, default: Date.now }
}, { collection: 'wpusers' });


const messageLogSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'WpUser', required: true },
  direction: { type: String, enum: ['outbound','inbound'], required: true },
  to:        { type: String },
  from:      { type: String },
  body:      { type: String, required: true },
  type:      { type: String, default: 'text' },   // text | reaction | sticker | image | etc.
  status:    { type: String, enum: ['sent','failed','received'], required: true },
  error:     { type: String, default: null },
  timestamp: { type: Date, default: Date.now }
});

messageLogSchema.index({ userId: 1, timestamp: -1 });

const WpUser     = mongoose.model('WpUser',      wpUserSchema);
const MessageLog = mongoose.model('MessageLog',  messageLogSchema);

module.exports = { WpUser, MessageLog };
