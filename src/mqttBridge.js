import mqtt from 'mqtt';
import { getDb } from './db.js';
import { isFcmEnabled, sendToTokens } from './fcm.js';
import dotenv from 'dotenv';

dotenv.config();

// Manage multiple MQTT clients keyed by broker URL + auth
const clients = new Map(); // key -> { client, topicToProjects: Map<topic, Set<projectId>> }
let currentSubs = new Map(); // projectId -> { topic, clientKey, sensorType, multiplier, offset, tankType, alertsEnabled, alertLow, alertHigh, alertCooldownSec, notifyOnRecover, alertHysteresisMeters }
const lastAlertState = new Map(); // projectId -> { lastState: 'normal'|'low'|'high', lastTs: number }
// Global hysteresis (meters) applied unless overridden per project.
const globalHysteresis = Number.isFinite(Number(process.env.ALERT_HYSTERESIS_METERS))
  ? Number(process.env.ALERT_HYSTERESIS_METERS)
  : 0;
let bridgeRunning = false;
// Optional per-message update notifications (very noisy) are disabled by default.
// Set NOTIFY_UPDATES=true to enable, and optionally NOTIFY_UPDATES_INTERVAL_SEC to throttle.
const notifyUpdates = String(process.env.NOTIFY_UPDATES).toLowerCase() === 'true';
const notifyUpdatesIntervalSec = Number.isFinite(Number(process.env.NOTIFY_UPDATES_INTERVAL_SEC))
  ? Math.max(0, Number(process.env.NOTIFY_UPDATES_INTERVAL_SEC))
  : 0; // 0 = no throttle if enabled
const lastUpdatePush = new Map(); // projectId -> last push timestamp (ms)

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
  // Pull projects that are relevant to the bridge: storeHistory OR alertsEnabled
  const projects = await db.collection('projects').find({ $or: [ { storeHistory: true }, { alertsEnabled: true } ] }).toArray();
  return projects.map(p => ({
    projectId: p.id,
    topic: p.topic,
    broker: p.broker,
    port: p.port || 1883,
    username: p.username,
    password: p.password,
    // whether to persist readings for this project
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
  // Re-sync project list periodically
  const intervalMs = Math.max(15000, Number(process.env.BRIDGE_REFRESH_MS || 60000));
  setInterval(() => refreshBridgeProjects().catch(() => {}), intervalMs);
}

export async function refreshBridgeProjects() {
  const db = await getDb();
  const list = await upsertProjectsFromDb();

  // Helper to build a client key and URL/auth for a project
  function clientConfigForProject(p) {
    // Per-project settings take precedence; fallback to global env if provided
    const urlFromEnv = process.env.MQTT_URL;
    const url = urlFromEnv || (p.broker && p.port ? `tcp://${p.broker}:${p.port}` : null);
    const username = process.env.MQTT_USERNAME || p.username || undefined;
    const password = process.env.MQTT_PASSWORD || p.password || undefined;
    if (!url) return null;
    const key = `${url}::${username || ''}`; // simple key including auth username
    return { key, url, username, password };
  }

  // Ensure clients exist for each required broker/auth
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
      const topicToProjects = new Map(); // topic -> Set(projectId)
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
            const doc = {
              projectId,
              levelMeters: v,
              percent: 0,
              liquidLiters: 0,
              totalLiters: 0,
              ts,
            };
            if (subCfg.storeHistory) {
              await db.collection('readings').insertOne(doc);
            }

            // Alerts evaluation with hysteresis
            if (subCfg.alertsEnabled) {
              const low = (typeof subCfg.alertLow === 'number') ? subCfg.alertLow : null;
              const high = (typeof subCfg.alertHigh === 'number') ? subCfg.alertHigh : null;
              const hysteresis = Number.isFinite(subCfg.alertHysteresisMeters) && subCfg.alertHysteresisMeters != null
                ? subCfg.alertHysteresisMeters
                : globalHysteresis;

              const prev = lastAlertState.get(projectId) || { lastState: 'normal', lastTs: 0 };
              let state = 'normal';

              // Apply hysteresis: stay in previous alert state until fully cleared by band
              if (prev.lastState === 'low') {
                if (low != null) {
                  if (v < low) state = 'low';
                  else if (hysteresis > 0 && v < (low + hysteresis)) state = 'low';
                }
              } else if (prev.lastState === 'high') {
                if (high != null) {
                  if (v > high) state = 'high';
                  else if (hysteresis > 0 && v > (high - hysteresis)) state = 'high';
                }
              }
              // If not latched above, evaluate fresh entry
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
              const shouldNotify = (crossedIntoAlert && cooledDown) || (recovered && subCfg.notifyOnRecover && cooledDown);

              if (shouldNotify && isFcmEnabled()) {
                try {
                  const deviceCursor = db.collection('devices').find({ $or: [ { projectId }, { projectId: null } ] }, { projection: { _id: 0, token: 1 } });
                  const devices = await deviceCursor.toArray();
                  const tokens = devices.map(d => d.token).filter(Boolean);
                  if (tokens.length) {
                    const res = await sendToTokens(tokens, {
                      notification: {
                        title: `${alertTitle} (${projectId})`,
                        body: `Level: ${v.toFixed(3)} m @ ${ts.toLocaleTimeString()}${hysteresis > 0 ? ` (hyst=${hysteresis}m)` : ''}`
                      },
                      data: {
                        projectId: String(projectId),
                        levelMeters: String(v),
                        ts: ts.toISOString(),
                        alertState: state,
                        hysteresisMeters: String(hysteresis),
                      }
                    });
                    const invalid = _collectInvalidTokens(res, tokens);
                    if (invalid.length) {
                      try { await db.collection('devices').deleteMany({ token: { $in: invalid } }); } catch {}
                    }
                  }
                } catch (e) {
                  console.warn('Bridge: FCM alert send failed', e?.message || e);
                }
              }

              if ((crossedIntoAlert && cooledDown) || recovered) {
                lastAlertState.set(projectId, { lastState: state, lastTs: nowMs });
                try {
                  await db.collection('projects').updateOne({ id: projectId }, {
                    $set: { lastAlertState: state, lastAlertAt: new Date(nowMs) }
                  });
                } catch {}
              }
            }

            if (isFcmEnabled() && notifyUpdates) {
              try {
                // Optional throttle for update notifications
                const nowMs2 = Date.now();
                const lastTs = lastUpdatePush.get(projectId) || 0;
                const minGapMs = notifyUpdatesIntervalSec * 1000;
                if (minGapMs > 0 && (nowMs2 - lastTs) < minGapMs) {
                  return; // skip due to throttle
                }
                const deviceCursor = db.collection('devices').find({ $or: [ { projectId }, { projectId: null } ] }, { projection: { _id: 0, token: 1 } });
                const devices = await deviceCursor.toArray();
                const tokens = devices.map(d => d.token).filter(Boolean);
                if (tokens.length) {
                  const res = await sendToTokens(tokens, {
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
                  const invalid = _collectInvalidTokens(res, tokens);
                  if (invalid.length) {
                    try { await db.collection('devices').deleteMany({ token: { $in: invalid } }); } catch {}
                  }
                  if (minGapMs > 0) lastUpdatePush.set(projectId, nowMs2);
                }
              } catch (e) {
                console.warn('Bridge: FCM send failed', e?.message || e);
              }
            }
          }
        } catch (e) {
          console.warn('Bridge: insert failed', e?.message || e);
        }
      });
      clients.set(cfg.key, { client: c, topicToProjects });
    }
  }

  // Unsubscribe/remove current subs that are no longer in the DB
  for (const [pid, cfg] of currentSubs.entries()) {
    if (!list.find(p => p.projectId === pid)) {
      const entry = clients.get(cfg.clientKey);
      if (entry) {
        try { entry.client.unsubscribe(cfg.topic); } catch {}
        const set = entry.topicToProjects.get(cfg.topic);
        if (set) { set.delete(pid); if (set.size === 0) entry.topicToProjects.delete(cfg.topic); }
      }
      currentSubs.delete(pid);
    }
  }

  // Subscribe new/updated
  for (const p of list) {
    if (!p.topic) continue;
    const cfg = clientConfigForProject(p);
    if (!cfg) continue;
    const entry = clients.get(cfg.key);
    if (!entry) continue; // should not happen
    const already = currentSubs.get(p.projectId);
    const topicChanged = already && already.topic !== p.topic;
    const clientChanged = already && already.clientKey !== cfg.key;
    if (!already || topicChanged || clientChanged) {
      // Unsubscribe old mapping if exists
      if (already) {
        const oldEntry = clients.get(already.clientKey);
        if (oldEntry) {
          try { oldEntry.client.unsubscribe(already.topic); } catch {}
          const set = oldEntry.topicToProjects.get(already.topic);
          if (set) { set.delete(p.projectId); if (set.size === 0) oldEntry.topicToProjects.delete(already.topic); }
        }
      }
      // Subscribe new
      entry.client.subscribe(p.topic, { qos: 0 }, (err) => {
        if (err) console.error('Bridge: subscribe error', p.topic, err?.message || err);
      });
      if (!entry.topicToProjects.has(p.topic)) entry.topicToProjects.set(p.topic, new Set());
      entry.topicToProjects.get(p.topic).add(p.projectId);
      currentSubs.set(p.projectId, {
        topic: p.topic,
        clientKey: cfg.key,
        sensorType: p.sensorType,
        multiplier: p.multiplier,
        offset: p.offset,
        tankType: p.tankType,
        storeHistory: p.storeHistory === true,
        alertsEnabled: p.alertsEnabled === true,
        alertLow: p.alertLow,
        alertHigh: p.alertHigh,
        alertCooldownSec: p.alertCooldownSec,
        notifyOnRecover: p.notifyOnRecover === true,
      });
    }
  }

  // Close clients that are no longer required
  for (const [key, entry] of clients.entries()) {
    if (!requiredKeys.has(key)) {
      try { entry.client.end(true); } catch {}
      clients.delete(key);
      console.log(`Bridge: MQTT client closed ${key}`);
    }
  }

  if (requiredKeys.size === 0 && clients.size === 0) {
    console.warn('Bridge: no active MQTT clients (no projects with storeHistory=true and no MQTT_URL override)');
  }
}
