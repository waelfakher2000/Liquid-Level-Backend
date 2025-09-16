import mqtt from 'mqtt';
import { getDb } from './db.js';
import { isFcmEnabled, sendToTokens } from './fcm.js';
import dotenv from 'dotenv';

dotenv.config();

let client;
let currentSubs = new Map(); // projectId -> { topic, sensorType, multiplier, offset, tankType }
let bridgeRunning = false;

function parseNumberFromPayload(payload, opts) {
  try {
    const s = payload.toString();
    // If JSON payload configured in project, we could extend here. For now, extract first number.
    const m = s.match(/[-+]?[0-9]*\.?[0-9]+/);
    if (!m) return null;
    let v = parseFloat(m[0]);
    // apply multiplier/offset if provided
    if (opts && typeof opts.multiplier === 'number') v = v * opts.multiplier;
    if (opts && typeof opts.offset === 'number') v = v + opts.offset;
    return v;
  } catch {
    return null;
  }
}

async function upsertProjectsFromDb() {
  const db = await getDb();
  // Pull projects that have storeHistory true
  const projects = await db.collection('projects').find({ storeHistory: true }).toArray();
  return projects.map(p => ({
    projectId: p.id,
    topic: p.topic,
    broker: p.broker,
    port: p.port || 1883,
    username: p.username,
    password: p.password,
    sensorType: p.sensorType,
    multiplier: typeof p.multiplier === 'number' ? p.multiplier : 1,
    offset: typeof p.offset === 'number' ? p.offset : 0,
    tankType: p.tankType,
  }));
}

export async function startBridge() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  await refreshBridgeProjects();
  // Re-sync project list periodically
  const intervalMs = Math.max(15000, Number(process.env.BRIDGE_REFRESH_MS || 60000));
  setInterval(() => refreshBridgeProjects().catch(() => {}), intervalMs);
}

export async function refreshBridgeProjects() {
  const db = await getDb();
  const list = await upsertProjectsFromDb();
  // Group by broker for now; if multiple brokers, we create one client per broker.
  // For simplicity, support a single broker via env MQTT_URL override.
  const mqttUrl = process.env.MQTT_URL; // e.g., tcp://broker:1883
  let connectUrl = mqttUrl;
  let auth = {};
  if (!connectUrl && list.length > 0) {
    const p = list[0];
    connectUrl = `tcp://${p.broker}:${p.port || 1883}`;
    auth = { username: p.username, password: p.password };
  }
  if (!connectUrl) {
    console.warn('Bridge: No MQTT broker configured and no projects found');
    return;
  }

  if (!client) {
    client = mqtt.connect(connectUrl, {
      username: process.env.MQTT_USERNAME || auth.username,
      password: process.env.MQTT_PASSWORD || auth.password,
      reconnectPeriod: 3000,
      clean: true,
    });
    client.on('connect', () => console.log('Bridge: MQTT connected'));
    client.on('reconnect', () => console.log('Bridge: MQTT reconnecting'));
    client.on('error', (e) => console.error('Bridge: MQTT error', e?.message || e));
    client.on('message', async (topic, msg) => {
      try {
        // Find matching project for this topic
        for (const [projectId, cfg] of currentSubs.entries()) {
          if (cfg.topic === topic) {
            const v = parseNumberFromPayload(msg, cfg);
            if (v == null) return;
            // Interpret: for submersible, v=level; for ultrasonic, v=distance -> convert if needed on server.
            // For now assume submersible-like behavior (level directly), matching app default.
            const ts = new Date();
            const doc = {
              projectId,
              levelMeters: v,
              percent: 0, // percent can be computed on the app/chart side or extended here when capacity known
              liquidLiters: 0,
              totalLiters: 0,
              ts,
            };
            await db.collection('readings').insertOne(doc);

            // Push FCM notification to registered devices
            if (isFcmEnabled()) {
              try {
                const deviceCursor = db.collection('devices').find({ $or: [ { projectId }, { projectId: null } ] }, { projection: { _id: 0, token: 1 } });
                const devices = await deviceCursor.toArray();
                const tokens = devices.map(d => d.token).filter(Boolean);
                if (tokens.length) {
                  await sendToTokens(tokens, {
                    notification: {
                      title: `Level update (${projectId})`,
                      body: `New level: ${v.toFixed(3)} m @ ${ts.toLocaleTimeString()}`
                    },
                    data: {
                      projectId: String(projectId),
                      levelMeters: String(v),
                      ts: ts.toISOString(),
                    }
                  });
                }
              } catch (e) {
                console.warn('Bridge: FCM send failed', e?.message || e);
              }
            }
          }
        }
      } catch (e) {
        console.warn('Bridge: insert failed', e?.message || e);
      }
    });
  }

  // Resubscribe to topics
  // Unsubscribe obsolete
  for (const [pid, cfg] of currentSubs.entries()) {
    if (!list.find(p => p.projectId === pid)) {
      try { client.unsubscribe(cfg.topic); } catch {}
      currentSubs.delete(pid);
    }
  }
  // Subscribe new
  for (const p of list) {
    if (!p.topic || currentSubs.has(p.projectId)) continue;
    client.subscribe(p.topic, { qos: 0 }, (err) => {
      if (err) console.error('Bridge: subscribe error', p.topic, err?.message || err);
    });
    currentSubs.set(p.projectId, {
      topic: p.topic,
      sensorType: p.sensorType,
      multiplier: p.multiplier,
      offset: p.offset,
      tankType: p.tankType,
    });
  }
}
