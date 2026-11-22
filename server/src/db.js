import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'meeting-md.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT, description TEXT,
    is_public INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, collection_id TEXT NOT NULL,
    end_user_id TEXT, status TEXT, metadata TEXT, callback_url TEXT,
    ws_connection_id TEXT, primary_video_channel_id TEXT,
    exported_video_id TEXT, export_status TEXT, created_at INTEGER, stopped_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS rtstreams (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, collection_id TEXT NOT NULL,
    channel_id TEXT, name TEXT, media_type TEXT, status TEXT,
    store INTEGER DEFAULT 1, is_primary INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rtstream_id TEXT NOT NULL,
    file TEXT NOT NULL, started_at REAL, ended_at REAL
  );
  CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rtstream_id TEXT NOT NULL, session_id TEXT NOT NULL,
    start REAL, end REAL, text TEXT
  );
  CREATE INDEX IF NOT EXISTS transcripts_session ON transcripts (session_id, start);
  CREATE TABLE IF NOT EXISTS scene_indexes (
    id TEXT PRIMARY KEY, rtstream_id TEXT NOT NULL, name TEXT, prompt TEXT,
    extraction_type TEXT, extraction_config TEXT, model_name TEXT,
    ws_connection_id TEXT, status TEXT, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scene_index_id TEXT NOT NULL,
    start REAL, end REAL, text TEXT
  );
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, collection_id TEXT NOT NULL, session_id TEXT,
    name TEXT, description TEXT, length REAL, size INTEGER, file TEXT, created_at INTEGER
  );
`);

export const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
export const now = () => Math.floor(Date.now() / 1000);

export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

/** Returns the caller's default collection, creating it on first use. */
export function defaultCollection(owner) {
  let row = one('SELECT * FROM collections WHERE owner = ? AND is_default = 1', owner);
  if (!row) {
    const id = newId('c');
    run(
      'INSERT INTO collections (id, owner, name, description, is_default, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      id, owner, 'Default Collection', 'Default collection', now()
    );
    row = one('SELECT * FROM collections WHERE id = ?', id);
  }
  return row;
}

export function getCollection(owner, id) {
  if (!id || id === 'default') return defaultCollection(owner);
  return one('SELECT * FROM collections WHERE id = ? AND owner = ?', id, owner);
}
