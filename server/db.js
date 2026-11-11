import Database from 'better-sqlite3';
import fs from 'fs';
import { dirname } from 'path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    email TEXT NOT NULL DEFAULT '',
    notify_email INTEGER NOT NULL DEFAULT 0,
    serverchan_key TEXT NOT NULL DEFAULT '',
    notify_serverchan INTEGER NOT NULL DEFAULT 0,
    notify_hour INTEGER NOT NULL DEFAULT 9,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users(id),
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    used_by INTEGER REFERENCES users(id),
    used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS family_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE,
    is_personal INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    production_date TEXT,
    shelf_life_value INTEGER,
    shelf_life_unit TEXT,
    expiry_date TEXT,
    base_date TEXT NOT NULL,
    photo_file TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    processed_kind TEXT,
    processed_by INTEGER REFERENCES users(id),
    processed_at INTEGER,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminder_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    last_stage INTEGER NOT NULL DEFAULT 0,
    last_reminded_on TEXT,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS digests (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS dispatch_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    last_attempt_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date, channel)
  );

  CREATE TABLE IF NOT EXISTS manuals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_id, status);
  CREATE INDEX IF NOT EXISTS idx_manuals_group ON manuals(group_id);
  CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(user_id);
`;

export function openDB(path) {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
