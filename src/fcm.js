import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import dotenv from 'dotenv';

dotenv.config();

let initialized = false;

export function initFcm() {
  if (initialized) return;
  try {
    // Load service account from file path. Do not JSON.parse env.
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || path.resolve(process.cwd(), 'service-account.json');
    if (!fs.existsSync(serviceAccountPath)) {
      console.warn('[FCM] Service account file not found; set GOOGLE_APPLICATION_CREDENTIALS or add service-account.json. FCM disabled');
      return;
    }

    // In ESM, emulate require to load JSON object
    const requireCjs = createRequire(import.meta.url);
    let serviceAccount;
    try {
      serviceAccount = requireCjs(serviceAccountPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (e) {
      // Fallback: pass path directly to Admin SDK (also supported by SDK)
      try {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccountPath) });
      } catch (e2) {
        console.warn('[FCM] Initialization failed:', e2?.message || e2);
        return;
      }
    }
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
