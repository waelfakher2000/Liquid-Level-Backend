import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getDb, initDb } from './db.js';
import { startBridge, refreshBridgeProjects } from './mqttBridge.js';
import { initFcm } from './fcm.js';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
// Register a device token for FCM notifications
// Body: { token: string, projectId?: string }
app.post('/register-device', async (req, res) => {
  try {
    const { token, projectId } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    const db = await getDb();
    const doc = {
      token,
      projectId: projectId || null,
      updatedAt: new Date(),
    };
    await db.collection('devices').updateOne({ token }, { $set: doc }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    const db = await getDb();
    const admin = db.admin();
    const info = await admin.serverStatus();
    res.json({ ok: true, info: { version: info.version } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Lightweight ping that doesn't touch Mongo (good for uptime monitors)
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Example route: list projects
app.get('/projects', async (req, res) => {
  try {
    const db = await getDb();
    const items = await db.collection('projects').find({}).limit(50).toArray();
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upsert a project (from app) so bridge can subscribe
// Body: {
//   id, name,
//   broker, port, topic, username?, password?,
//   storeHistory,
//   multiplier?, offset?, sensorType?, tankType?,
//   alertsEnabled?, alertLow?, alertHigh?, alertCooldownSec?, notifyOnRecover?
// }
app.post('/projects', async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const db = await getDb();
    const doc = {
      id,
      name: body.name || '',
      broker: body.broker,
      port: Number(body.port || 1883),
      topic: body.topic,
      username: body.username || null,
      password: body.password || null,
      storeHistory: body.storeHistory === true,
      multiplier: typeof body.multiplier === 'number' ? body.multiplier : 1,
      offset: typeof body.offset === 'number' ? body.offset : 0,
      sensorType: body.sensorType,
      tankType: body.tankType,
      alertsEnabled: body.alertsEnabled === true,
      alertLow: (typeof body.alertLow === 'number') ? body.alertLow : null,
      alertHigh: (typeof body.alertHigh === 'number') ? body.alertHigh : null,
      alertCooldownSec: Number.isFinite(body.alertCooldownSec) ? Number(body.alertCooldownSec) : 1800, // default 30m
      notifyOnRecover: body.notifyOnRecover === true,
      alertHysteresisMeters: (typeof body.alertHysteresisMeters === 'number' && body.alertHysteresisMeters >= 0)
        ? body.alertHysteresisMeters
        : null,
      updatedAt: new Date(),
    };
    await db.collection('projects').updateOne({ id }, { $set: doc }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Store a reading
// Body: { projectId: string, levelMeters: number, percent: number, liquidLiters: number, totalLiters: number, ts?: ISOString }
app.post('/readings', async (req, res) => {
  try {
    const { projectId, levelMeters, percent, liquidLiters, totalLiters, ts } = req.body || {};
    if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
    const now = new Date(ts || Date.now());
    const db = await getDb();
    const doc = {
      projectId,
      levelMeters: Number(levelMeters ?? 0),
      percent: Number(percent ?? 0),
      liquidLiters: Number(liquidLiters ?? 0),
      totalLiters: Number(totalLiters ?? 0),
      ts: now,
    };
    await db.collection('readings').insertOne(doc);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Query readings for charts
// Query params: projectId (required), from (ISO), to (ISO), limit (default 500)
app.get('/readings', async (req, res) => {
  try {
    const { projectId, from, to, limit } = req.query;
    if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
    const db = await getDb();
    const q = { projectId };
    if (from || to) {
      q.ts = {};
      if (from) q.ts.$gte = new Date(from);
      if (to) q.ts.$lte = new Date(to);
    }
    const lim = Math.min(Number(limit || 500), 5000);
    const items = await db
      .collection('readings')
      .find(q, { projection: { _id: 0 } })
      .sort({ ts: 1 })
      .limit(lim)
      .toArray();
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const port = Number(process.env.PORT);
if (!port || Number.isNaN(port)) {
  console.error('Missing required PORT environment variable. On Render, this is injected automatically.');
  process.exit(1);
}
initDb().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`API listening on port ${port}`);
  });
  // Start MQTT bridge after DB init
  initFcm();
  startBridge().catch(err => console.error('Bridge start error', err));
});

// Admin endpoint to reload bridge projects (optional)
app.post('/bridge/reload', async (req, res) => {
  try {
    await refreshBridgeProjects();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
