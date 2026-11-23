'use strict';
// SQLite storage (Node's built-in node:sqlite, so there are no dependencies to install).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const file = process.env.DATABASE_FILE || path.join(__dirname, 'data', 'app.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL,
  seats INTEGER NOT NULL,
  stripe_customer_id TEXT,
  stripe_sub_id TEXT,
  sub_status TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  pilot TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','consultant')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT,
  email TEXT,
  role TEXT,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_user ON history(user_id, ts);
CREATE TABLE IF NOT EXISTS library (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ind TEXT NOT NULL,
  obj TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS library_tenant ON library(tenant_id, ts);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_tenant ON usage(tenant_id, ts);
CREATE TABLE IF NOT EXISTS ai_calls (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
`);

const q = {
  one: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
};

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, q, tx };
