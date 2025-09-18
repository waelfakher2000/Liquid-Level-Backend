import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb, initDb } from './db.js';
import { startBridge, refreshBridgeProjects } from './mqttBridge.js';
import { initFcm } from './fcm.js';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// --- Auth Helpers ---
function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET env var required');
  return s;
}

async function findUserByEmail(db, email) {
  return db.collection('users').findOne({ email: email.toLowerCase() });
}

function issueToken(user) {
  const payload = { uid: user._id.toString(), email: user.email };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '30d' });
}

async function authMiddleware(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'missing bearer token' });
    const token = auth.substring(7);
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded; // { uid, email }
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
}

// --- Auth Routes ---
// Body: { email, password }
app.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'email and password (min 6 chars) required' });
    }
    const db = await getDb();
    const existing = await findUserByEmail(db, email);
    if (existing) return res.status(409).json({ ok: false, error: 'email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const userDoc = { email: email.toLowerCase(), passwordHash, createdAt: new Date() };
    const insertRes = await db.collection('users').insertOne(userDoc);
    // Optionally auto-login after signup
    const token = issueToken({ _id: insertRes.insertedId, email: userDoc.email });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });
    const db = await getDb();
    const user = await findUserByEmail(db, email);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ ok: false, error: 'invalid credentials' });
    const token = issueToken(user);
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simple token validation & user info
app.get('/me', authMiddleware, async (req, res) => {
  try {
    res.json({ ok: true, user: { id: req.user.uid, email: req.user.email } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// Register a device token for FCM notifications
// Body: { token: string, projectId?: string }
app.post('/register-device', authMiddleware, async (req, res) => {
  try {
    const { token, projectId } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    const db = await getDb();
    const doc = {
      token,
      projectId: projectId || null,
      userId: req.user.uid,
      updatedAt: new Date(),
    };
    await db.collection('devices').updateOne({ token, userId: req.user.uid }, { $set: doc }, { upsert: true });
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
app.get('/projects', authMiddleware, async (req, res) => {
  try {
    const db = await getDb();
    const items = await db.collection('projects').find({ userId: req.user.uid }).limit(200).toArray();
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
app.post('/projects', authMiddleware, async (req, res) => {
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
      // --- Extended persisted fields for cross-device sync (optional on POST) ---
      height: (typeof body.height === 'number') ? body.height : null,
      diameter: (typeof body.diameter === 'number') ? body.diameter : null,
      length: (typeof body.length === 'number') ? body.length : null,
      width: (typeof body.width === 'number') ? body.width : null,
      wallThickness: (typeof body.wallThickness === 'number') ? body.wallThickness : null,
      minThreshold: (typeof body.minThreshold === 'number') ? body.minThreshold : null,
      maxThreshold: (typeof body.maxThreshold === 'number') ? body.maxThreshold : null,
      connectedTankCount: Number.isFinite(body.connectedTankCount) ? Number(body.connectedTankCount) : 1,
      useCustomFormula: body.useCustomFormula === true,
      customFormula: (typeof body.customFormula === 'string' && body.customFormula.trim().length) ? body.customFormula.trim() : null,
      useControlButton: body.useControlButton === true,
      controlTopic: (typeof body.controlTopic === 'string' && body.controlTopic.trim().length) ? body.controlTopic.trim() : null,
      controlMode: body.controlMode,
      onValue: (typeof body.onValue === 'string') ? body.onValue : 'ON',
      offValue: (typeof body.offValue === 'string') ? body.offValue : 'OFF',
      autoControl: body.autoControl === true,
      controlRetained: body.controlRetained === true,
      controlQos: body.controlQos,
      lastWillTopic: (typeof body.lastWillTopic === 'string' && body.lastWillTopic.trim().length) ? body.lastWillTopic.trim() : null,
      payloadIsJson: body.payloadIsJson === true,
      jsonFieldIndex: Number.isFinite(body.jsonFieldIndex) ? Number(body.jsonFieldIndex) : 1,
      jsonKeyName: (typeof body.jsonKeyName === 'string' && body.jsonKeyName.trim().length) ? body.jsonKeyName.trim() : null,
      displayTimeFromJson: body.displayTimeFromJson === true,
      jsonTimeFieldIndex: Number.isFinite(body.jsonTimeFieldIndex) ? Number(body.jsonTimeFieldIndex) : 1,
      jsonTimeKeyName: (typeof body.jsonTimeKeyName === 'string' && body.jsonTimeKeyName.trim().length) ? body.jsonTimeKeyName.trim() : null,
      createdAt: body.createdAt ? new Date(body.createdAt) : new Date(),
      userId: req.user.uid,
      updatedAt: new Date(),
    };
    await db.collection('projects').updateOne({ id, userId: req.user.uid }, { $set: doc }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete a project
app.delete('/projects/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const db = await getDb();
    const del = await db.collection('projects').deleteOne({ id, userId: req.user.uid });
    res.json({ ok: true, deleted: del.deletedCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Store a reading
// Body: { projectId: string, levelMeters: number, percent: number, liquidLiters: number, totalLiters: number, ts?: ISOString }
app.post('/readings', authMiddleware, async (req, res) => {
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
      userId: req.user.uid,
    };
    await db.collection('readings').insertOne(doc);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Query readings for charts
// Query params: projectId (required), from (ISO), to (ISO), limit (default 500)
app.get('/readings', authMiddleware, async (req, res) => {
  try {
    const { projectId, from, to, limit } = req.query;
    if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
    const db = await getDb();
    const q = { projectId, userId: req.user.uid };
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
    try {
      const routes = [];
      app._router?.stack?.forEach(layer => {
        if (layer.route && layer.route.path) {
          routes.push(`${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
        }
      });
      console.log('[RouteList]', routes.join(' | '));
    } catch (e) {
      console.log('Route list error', e.message);
    }
  });
  // Start MQTT bridge after DB init
  initFcm();
  startBridge().catch(err => console.error('Bridge start error', err));
});

// Diagnostics: list registered top-level routes (non-production recommended)
app.get('/debug/routes', (req, res) => {
  try {
    const out = [];
    app._router?.stack?.forEach(layer => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods).join(',');
        out.push({ path: layer.route.path, methods });
      }
    });
    res.json({ ok: true, routes: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Version endpoint (include commit SHA if provided at build time via env)
app.get('/version', (req, res) => {
  res.json({ ok: true, sha: process.env.GIT_COMMIT || null });
});

app.get('/routes-check', (req, res) => {
  try {
    const info = {};
    const list = [];
    app._router?.stack?.forEach(layer => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods);
        list.push({ path: layer.route.path, methods });
        if (layer.route.path === '/signup') info.signup = true;
      }
    });
    res.json({ ok: true, signupPresent: info.signup === true, routes: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Admin endpoint to reload bridge projects (optional)
app.post('/bridge/reload', authMiddleware, async (req, res) => {
  try {
    await refreshBridgeProjects();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
