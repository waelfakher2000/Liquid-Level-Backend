import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

let initialized = false;

export function initFcm() {
  if (initialized) return;
  try {
    // Prefer JSON from env for container/secret-friendly deployments
    const jsonFromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    let credential;
    if (jsonFromEnv) {
      const obj = JSON.parse(jsonFromEnv);
      credential = admin.credential.cert(obj);
    } else {
      const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
        || path.resolve(process.cwd(), 'service-account.json');
      if (!fs.existsSync(serviceAccountPath)) {
        console.warn('[FCM] service-account.json not found; FCM disabled');
        return;
      }
      credential = admin.credential.cert(serviceAccountPath);
    }

    admin.initializeApp({ credential });
    initialized = true;
    console.log('[FCM] Admin initialized');
  } catch (e) {
    console.warn('[FCM] Initialization failed:', e?.message || e);
  }
}

export function isFcmEnabled() {
  return initialized;
}

export async function sendToTokens(tokens, payload, options = {}) {
  if (!initialized || !tokens?.length) return { ok: false, error: 'FCM disabled or no tokens' };
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: payload.notification,
      data: payload.data,
      android: options.android,
      apns: options.apns,
    });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
