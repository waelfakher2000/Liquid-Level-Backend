import { MongoClient, ServerApiVersion } from 'mongodb';
import { setDefaultResultOrder } from 'node:dns';
import dotenv from 'dotenv';

dotenv.config();

// Prefer IPv4 for SRV lookups to avoid TLS handshake issues on some hosts
try {
  if (typeof setDefaultResultOrder === 'function') {
    setDefaultResultOrder('ipv4first');
  }
} catch {}

const uri = process.env.MONGODB_URI;
if (!uri) {
  const msg = 'MONGODB_URI is required. Set it in your hosting environment (Render: Service → Environment → Add Variable).';
  console.error(msg);
  // Throw to fail fast during startup, avoiding confusing MongoClient errors
  throw new Error(msg);
}

export const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let cachedDb; // cache between hot reloads

export async function getDb() {
  if (!cachedDb) {
    await client.connect();
    const dbName = process.env.MONGODB_DB || 'liquidlevel';
    cachedDb = client.db(dbName);
    // ping once
    await cachedDb.command({ ping: 1 });
    console.log('Connected to MongoDB and pinged successfully');
  }
  return cachedDb;
}

export async function closeDb() {
  try {
    await client.close();
    cachedDb = undefined;
  } catch (e) {
    console.warn('Error closing Mongo client', e);
  }
}

// Ensure useful indexes exist. Call this on server start.
export async function initDb() {
  const db = await getDb();
  const readings = db.collection('readings');
  // Index for fast range queries by project and timestamp (desc)
  await readings.createIndex({ projectId: 1, ts: -1 });
  // Optional TTL retention (days) via env var READINGS_TTL_DAYS
  const ttlDays = Number(process.env.READINGS_TTL_DAYS || 0);
  if (ttlDays > 0) {
    // Create/update TTL index on ts
    try {
      await readings.createIndex(
        { ts: 1 },
        { expireAfterSeconds: Math.floor(ttlDays * 24 * 3600), name: 'ttl_ts' }
      );
    } catch (e) {
      console.warn('TTL index create warning:', e?.message || e);
    }
  }
}
