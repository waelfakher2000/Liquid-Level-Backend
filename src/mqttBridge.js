
import mqtt from 'mqtt';
import { getDb } from './db.js';
import { isFcmEnabled, sendToTokens } from './fcm.js';
import dotenv from 'dotenv';

dotenv.config();

const clients = new Map();
let currentSubs = new Map();
const lastAlertState = new Map();
const globalHysteresis = Number.isFinite(Number(process.env.ALERT_HYSTERESIS_METERS)) ? Number(process.env.ALERT_HYSTERESIS_METERS) : 0;
let bridgeRunning = false;
const notifyUpdates = String(process.env.NOTIFY_UPDATES).toLowerCase() === 'true';
const notifyUpdatesIntervalSec = Number.isFinite(Number(process.env.NOTIFY_UPDATES_INTERVAL_SEC)) ? Math.max(0, Number(process.env.NOTIFY_UPDATES_INTERVAL_SEC)) : 0;
const lastUpdatePush = new Map();

// --- Simple 3mm suppression ---
// Any reading whose absolute difference from the last STORED value for the same project
// is < 0.003 meters (3 mm) is skipped. No timers, no rounding, no env config.
// Alert transitions still force storage so history shows them.
const lastStoredReading = new Map(); // projectId -> { value, tsMs }

function _collectInvalidTokens(sendRes, tokens) {
  try {
    if (!sendRes || !sendRes.res || !Array.isArray(sendRes.res.responses)) return [];
    const bad = [];
    const responses = sendRes.res.responses;
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      if (r && r.error && tokens[i]) {
        const code = r.error.code || r.error.message || '';
        if (String(code).includes('registration-token-not-registered') || String(code).includes('UNREGISTERED')) {
          bad.push(tokens[i]);
        }
      }
    }
    return bad;
  } catch { return []; }
}

function parseNumberFromPayload(payload, opts) {
  try {
    const s = payload.toString();
    const m = s.match(/[-+]?[0-9]*\.?[0-9]+/);
    if (!m) return null;
    let v = parseFloat(m[0]);
    if (opts && typeof opts.multiplier === 'number') v = v * opts.multiplier;
    if (opts && typeof opts.offset === 'number') v = v + opts.offset;
    return v;
  } catch { return null; }
}

async function upsertProjectsFromDb() {
  const db = await getDb();
  const projects = await db.collection('projects').find({ $or: [ { storeHistory: true }, { alertsEnabled: true } ] }).toArray();
  return projects.map(p => ({
    projectId: p.id,
    projectName: p.name || '',
    topic: p.topic,
    broker: p.broker,
    port: p.port || 1883,
    username: p.username,
    password: p.password,
    storeHistory: p.storeHistory === true,
    sensorType: p.sensorType,
    multiplier: typeof p.multiplier === 'number' ? p.multiplier : 1,
    offset: typeof p.offset === 'number' ? p.offset : 0,
    tankType: p.tankType,
    alertsEnabled: p.alertsEnabled === true,
    alertLow: (typeof p.alertLow === 'number') ? p.alertLow : null,
    alertHigh: (typeof p.alertHigh === 'number') ? p.alertHigh : null,
    alertCooldownSec: Number.isFinite(p.alertCooldownSec) ? Number(p.alertCooldownSec) : 1800,
    notifyOnRecover: p.notifyOnRecover === true,
    alertHysteresisMeters: Number.isFinite(p.alertHysteresisMeters) ? Number(p.alertHysteresisMeters) : null,
  }));
}

export async function startBridge() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  await refreshBridgeProjects();
  const intervalMs = Math.max(15000, Number(process.env.BRIDGE_REFRESH_MS || 60000));
  setInterval(() => refreshBridgeProjects().catch(() => {}), intervalMs);
}

export async function refreshBridgeProjects() {
  const db = await getDb();
  const list = await upsertProjectsFromDb();

  function clientConfigForProject(p) {
    const urlFromEnv = process.env.MQTT_URL;
    const url = urlFromEnv || (p.broker && p.port ? `tcp://${p.broker}:${p.port}` : null);
    const username = process.env.MQTT_USERNAME || p.username || undefined;
    const password = process.env.MQTT_PASSWORD || p.password || undefined;
    if (!url) return null;
    const key = `${url}::${username || ''}`;
    return { key, url, username, password };
  }

  const requiredKeys = new Set();
  for (const p of list) {
    const cfg = clientConfigForProject(p);
    if (!cfg) continue;
    requiredKeys.add(cfg.key);
    if (!clients.has(cfg.key)) {
      const c = mqtt.connect(cfg.url, {
        username: cfg.username,
        password: cfg.password,
        reconnectPeriod: 3000,
        clean: true,
      });
      const topicToProjects = new Map();
      c.on('connect', () => console.log(`Bridge: MQTT connected ${cfg.url}`));
      c.on('reconnect', () => console.log(`Bridge: MQTT reconnecting ${cfg.url}`));
      c.on('error', (e) => console.error(`Bridge: MQTT error ${cfg.url}`, e?.message || e));
      c.on('message', async (topic, msg) => {
        try {
          const projectIds = topicToProjects.get(topic);
          if (!projectIds || projectIds.size === 0) return;
          for (const projectId of projectIds) {
            const subCfg = currentSubs.get(projectId);
            if (!subCfg) continue;
            const v = parseNumberFromPayload(msg, subCfg);
            if (v == null) continue;
            const ts = new Date();
            // ---- Simple 3mm suppression ----
            let storeThis = subCfg.storeHistory === true;
            const prevStored = lastStoredReading.get(projectId);
            if (storeThis && prevStored) {
              const diff = Math.abs(prevStored.value - v);
              if (diff < 0.003) {
                storeThis = false; // skip tiny change
              }
            }
            if (subCfg.alertsEnabled) {
              const low = (typeof subCfg.alertLow === 'number') ? subCfg.alertLow : null;
              const high = (typeof subCfg.alertHigh === 'number') ? subCfg.alertHigh : null;
              const hysteresis = Number.isFinite(subCfg.alertHysteresisMeters) && subCfg.alertHysteresisMeters != null ? subCfg.alertHysteresisMeters : globalHysteresis;
              const prev = lastAlertState.get(projectId) || { lastState: 'normal', lastTs: 0 };
              let state = 'normal';
              if (prev.lastState === 'low') {
                if (low != null) {
                  if (v < low) state = 'low'; else if (hysteresis > 0 && v < (low + hysteresis)) state = 'low';
                }
              } else if (prev.lastState === 'high') {
                if (high != null) {
                  if (v > high) state = 'high'; else if (hysteresis > 0 && v > (high - hysteresis)) state = 'high';
                }
              }
              if (state === 'normal') {
                if (low != null && v < low) state = 'low';
                else if (high != null && v > high) state = 'high';
              }
              const nowMs = Date.now();
              const cooldownMs = Math.max(0, Number(subCfg.alertCooldownSec || 0) * 1000);
              const cooledDown = (nowMs - prev.lastTs) >= cooldownMs;
              const crossedIntoAlert = (prev.lastState === 'normal' && (state === 'low' || state === 'high'));
              const recovered = (prev.lastState !== 'normal' && state === 'normal');
              const alertTitle = state === 'low' ? 'Low level alert' : state === 'high' ? 'High level alert' : 'Level back to normal';
              const displayName = (subCfg.projectName && subCfg.projectName.trim().length) ? subCfg.projectName.trim() : projectId;
              const shouldNotify = (crossedIntoAlert && cooledDown) || (recovered && subCfg.notifyOnRecover && cooledDown);
              if (shouldNotify && isFcmEnabled()) {
                try {
                  const deviceCursor = db.collection('devices').find({ $or: [ { projectId }, { projectId: null } ] }, { projection: { _id: 0, token: 1 } });
                  const devices = await deviceCursor.toArray();
                  const tokens = devices.map(d => d.token).filter(Boolean);
                  if (tokens.length) {
                    const res = await sendToTokens(tokens, {
                      notification: { title: `${alertTitle} (${displayName})`, body: `Level: ${v.toFixed(3)} m @ ${ts.toLocaleTimeString()}${hysteresis > 0 ? ` (hyst=${hysteresis}m)` : ''}` },
                      data: { projectId: String(projectId), projectName: displayName, levelMeters: String(v), ts: ts.toISOString(), alertState: state, hysteresisMeters: String(hysteresis) }
                    });
                    const invalid = _collectInvalidTokens(res, tokens);
                    if (invalid.length) { try { await db.collection('devices').deleteMany({ token: { $in: invalid } }); } catch {} }
                  }
                } catch (err) { console.error('Bridge: FCM send error', err?.message || err); }
              }
              if ((crossedIntoAlert && cooledDown) || recovered) {
                lastAlertState.set(projectId, { lastState: state, lastTs: nowMs });
                try { await db.collection('projects').updateOne({ id: projectId }, { $set: { lastAlertState: state, lastAlertAt: new Date(nowMs) } }); } catch {}
                // Force storing this reading even if it would have been skipped, to reflect transition.
                if (!storeThis && subCfg.storeHistory) storeThis = true;
              }
            }
            if (storeThis && subCfg.storeHistory) {
              try {
                await db.collection('readings').insertOne({
                  projectId,
                  levelMeters: v,
                  ts,
                });
                lastStoredReading.set(projectId, { value: v, ts: Date.now() });
              } catch (e) { console.error('Bridge: insert error', e?.message || e); }
            }
            if (notifyUpdates && isFcmEnabled()) {
              const lastPush = lastUpdatePush.get(projectId) || 0;
              const now = Date.now();
              if (!notifyUpdatesIntervalSec || (now - lastPush) > notifyUpdatesIntervalSec * 1000) {
                try {
                  const deviceCursor = db.collection('devices').find({ $or: [ { projectId }, { projectId: null } ] }, { projection: { _id: 0, token: 1 } });
                  const devices = await deviceCursor.toArray();
                  const tokens = devices.map(d => d.token).filter(Boolean);
                  if (tokens.length) {
                    const displayName = (subCfg.projectName && subCfg.projectName.trim().length) ? subCfg.projectName.trim() : projectId;
                    const res = await sendToTokens(tokens, { notification: { title: `Level update (${displayName})`, body: `New level: ${v.toFixed(3)} m @ ${ts.toLocaleTimeString()}` }, data: { projectId: String(projectId), projectName: displayName, levelMeters: String(v), ts: ts.toISOString() } });
                    const invalid = _collectInvalidTokens(res, tokens);
                    if (invalid.length) { try { await db.collection('devices').deleteMany({ token: { $in: invalid } }); } catch {} }
                  }
                  lastUpdatePush.set(projectId, now);
                } catch (err) { console.error('Bridge: update push error', err?.message || err); }
              }
            }
          }
        } catch (e) { console.error('Bridge: message handler error', e?.message || e); }
      });
      clients.set(cfg.key, { client: c, topicToProjects });
    }
  }
  for (const [key, entry] of clients.entries()) {
    if (!requiredKeys.has(key)) { try { entry.client.end(true); } catch {}; clients.delete(key); }
  }
  for (const p of list) {
    const cfg = clientConfigForProject(p);
    if (!cfg) continue;
    const entry = clients.get(cfg.key);
    if (!entry) continue;
    if (!entry.topicToProjects.has(p.topic)) entry.topicToProjects.set(p.topic, new Set());
    entry.topicToProjects.get(p.topic).add(p.projectId);
    currentSubs.set(p.projectId, { topic: p.topic, clientKey: cfg.key, sensorType: p.sensorType, multiplier: p.multiplier, offset: p.offset, tankType: p.tankType, alertsEnabled: p.alertsEnabled, alertLow: p.alertLow, alertHigh: p.alertHigh, alertCooldownSec: p.alertCooldownSec, notifyOnRecover: p.notifyOnRecover, alertHysteresisMeters: p.alertHysteresisMeters, projectName: p.projectName });
  }
  for (const [pid] of currentSubs.entries()) { if (!list.find(p => p.projectId === pid)) { currentSubs.delete(pid); } }
  if (requiredKeys.size === 0 && clients.size === 0) { console.warn('Bridge: no active MQTT clients (no projects with storeHistory=true and no MQTT_URL override)'); }
}
