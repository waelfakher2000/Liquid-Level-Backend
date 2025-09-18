#!/usr/bin/env node
/**
 * Cleanup legacy readings lacking userId.
 * Usage:
 *   DRY_RUN=1 node scripts/cleanup_legacy_readings.js
 *   node scripts/cleanup_legacy_readings.js
 *
 * Env required:
 *   MONGODB_URI (and optional MONGODB_DB)
 */
import('./../src/db.js').then(async (m) => {
  const { getDb, closeDb } = m;
  const db = await getDb();
  const col = db.collection('readings');
  const filter = { userId: { $exists: false } };
  const count = await col.countDocuments(filter);
  const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  if (dry) {
    console.log(`[DRY_RUN] Found ${count} legacy readings without userId. No deletions performed.`);
  } else {
    if (count === 0) {
      console.log('No legacy readings to delete.');
    } else {
      const res = await col.deleteMany(filter);
      console.log(`Deleted ${res.deletedCount} legacy readings missing userId.`);
    }
  }
  await closeDb();
  process.exit(0);
}).catch(e => {
  console.error('Cleanup failed:', e);
  process.exit(1);
});
