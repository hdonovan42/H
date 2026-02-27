import Database from 'better-sqlite3'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, 'data')
const DB_PATH = resolve(DATA_DIR, 'autosnipe.db')

let db

export function getDb() {
  if (!db) {
    mkdirSync(DATA_DIR, { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 10000')
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = -64000')
    db.pragma('temp_store = MEMORY')
    migrate(db)
  }
  return db
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      tier TEXT DEFAULT 'free',
      paid_slots INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT,
      criteria TEXT NOT NULL,
      autotrader_url TEXT,
      active INTEGER DEFAULT 1,
      last_checked TEXT,
      last_result_count INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL REFERENCES searches(id),
      autotrader_id TEXT NOT NULL,
      title TEXT,
      price INTEGER,
      mileage INTEGER,
      year INTEGER,
      fuel_type TEXT,
      transmission TEXT,
      url TEXT,
      image_url TEXT,
      seller_type TEXT,
      location TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      notified_at TEXT,
      UNIQUE(search_id, autotrader_id)
    );

    CREATE TABLE IF NOT EXISTS poll_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL REFERENCES searches(id),
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT DEFAULT 'running',
      listings_found INTEGER DEFAULT 0,
      new_listings INTEGER DEFAULT 0,
      iterations INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      stripe_session_id TEXT UNIQUE,
      currency TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      handled_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_id);
    CREATE INDEX IF NOT EXISTS idx_listings_autotrader ON listings(autotrader_id);
    CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id);
    CREATE INDEX IF NOT EXISTS idx_searches_active ON searches(active);
    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
  `)

  // Migrate existing DBs: add paid_slots column if missing
  try {
    db.prepare('SELECT paid_slots FROM users LIMIT 1').get()
  } catch {
    db.exec('ALTER TABLE users ADD COLUMN paid_slots INTEGER DEFAULT 0')
  }

  // Add poll_log metrics columns if missing
  try {
    db.prepare('SELECT response_time_ms FROM poll_log LIMIT 1').get()
  } catch {
    db.exec('ALTER TABLE poll_log ADD COLUMN response_time_ms INTEGER')
  }
  try {
    db.prepare('SELECT scraper_engine FROM poll_log LIMIT 1').get()
  } catch {
    db.exec("ALTER TABLE poll_log ADD COLUMN scraper_engine TEXT DEFAULT 'sss'")
  }

  // Add stripe subscription columns if missing
  try {
    db.prepare('SELECT stripe_subscription_id FROM users LIMIT 1').get()
  } catch {
    db.exec('ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT')
  }
  try {
    db.prepare('SELECT stripe_subscription_item_id FROM users LIMIT 1').get()
  } catch {
    db.exec('ALTER TABLE users ADD COLUMN stripe_subscription_item_id TEXT')
  }
}
