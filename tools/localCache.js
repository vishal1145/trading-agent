/**
 * Finvedas Trading Agent — Local SQLite Cache Layer
 * Sits in front of Snowflake to dramatically reduce query costs.
 *
 * Strategy:
 *   - First request  → Cache miss → hits Snowflake → saves result to SQLite
 *   - Every request within TTL → Cache hit → reads from SQLite (Snowflake never touched)
 *   - After TTL expires → Cache miss → refreshes from Snowflake again
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../trading_cache.db');

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');   // Write-Ahead Logging for concurrent reads
  db.pragma('synchronous = NORMAL'); // Faster writes, still safe

  // Cache store table (all data cached here as serialised JSON)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_store (
      cache_key   TEXT PRIMARY KEY,
      data        TEXT NOT NULL,
      cached_at   INTEGER NOT NULL
    );
  `);
  console.log('📦 Local SQLite cache initialised at:', DB_PATH);
} catch (err) {
  console.warn('⚠️ SQLite cache init failed (will bypass cache):', err.message);
  db = null;
}

// ─── Cache TTL per key type ──────────────────────────────
const EXPIRY_MS = {
  options_data:           5 * 60 * 1000,    // 5 min   — options tick data changes rapidly
  active_orders:          5 * 60 * 1000,    // 5 min   — live position data
  pnl_snapshot:           5 * 60 * 1000,    // 5 min   — platform PnL
  latest_ltp:             2 * 60 * 1000,    // 2 min   — live price ticker
  user_sentiment:        60 * 60 * 1000,    // 1 hour  — order history changes less often
  market_breadth:         5 * 60 * 1000,    // 5 min   — breadth data
  historical_stats:      60 * 60 * 1000,    // 1 hour  — deep historical stats
  available_instruments: 60 * 60 * 1000,    // 1 hour  — instrument list
};

// ─── Determine TTL for a given key ───────────────────────
const getTTL = (key) => {
  for (const [prefix, ms] of Object.entries(EXPIRY_MS)) {
    if (key.startsWith(prefix)) return ms;
  }
  return 5 * 60 * 1000; // Default: 5 minutes
};

// ─── Read from Cache ─────────────────────────────────────
export const getFromCache = (key) => {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT data, cached_at FROM cache_store WHERE cache_key = ?').get(key);
    if (!row) return null;

    const age = Date.now() - Number(row.cached_at);
    if (age > getTTL(key)) return null; // expired

    return JSON.parse(row.data);
  } catch (err) {
    console.warn(`⚠️ Cache read error for ${key}:`, err.message);
    return null;
  }
};

// ─── Write to Cache ──────────────────────────────────────
export const saveToCache = (key, data) => {
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO cache_store (cache_key, data, cached_at)
      VALUES (?, ?, ?)
    `).run(key, JSON.stringify(data), Date.now());
  } catch (err) {
    console.warn(`⚠️ Cache write error for ${key}:`, err.message);
  }
};

// ─── Invalidate a specific cache key ─────────────────────
export const invalidateCache = (key) => {
  if (!db) return;
  try {
    db.prepare('DELETE FROM cache_store WHERE cache_key = ?').run(key);
  } catch (err) {
    console.warn(`⚠️ Cache invalidation error for ${key}:`, err.message);
  }
};

// ─── Flush all cache entries ─────────────────────────────
export const flushCache = () => {
  if (!db) return;
  try {
    db.prepare('DELETE FROM cache_store').run();
    console.log('🗑️ Cache flushed');
  } catch (err) {
    console.warn('⚠️ Cache flush error:', err.message);
  }
};
