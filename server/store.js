/* store.js — persistence for the Mystica server.
 *
 * Memory is the game; this file only exists so the world survives a restart. SQLite (Node's built-in
 * node:sqlite, no native dependency), one file per world seed, WAL mode. Tables:
 *   chunks   one binary blob per 32x32-tile chunk of player-made terrain (format in sim.js, versioned)
 *   kv       small JSON documents: town state, animals
 *   actions  append-only log of what players did, for disputes and bounties later
 * Chunk writes are batched in one transaction per flush and only dirty chunks are written.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(file, opts) {
    opts = opts || {};
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Mirror: on a platform whose durable storage is a network share (Azure Files), SQLite cannot lock
    // files there. So the live database lives on local disk and, after every flush, a consistent copy
    // is written to the share (VACUUM INTO, then rename). On start the copy is restored if the local
    // file is missing. The loss bound stays one flush interval.
    this.mirrorFile = opts.mirror ? path.join(opts.mirror, path.basename(file)) : null;
    this.restored = false;
    if (this.mirrorFile && !fs.existsSync(file) && fs.existsSync(this.mirrorFile)) {
      fs.mkdirSync(opts.mirror, { recursive: true });
      fs.copyFileSync(this.mirrorFile, file);
      this.restored = true;
    }
    this.db = new DatabaseSync(file);
    // WAL needs shared memory, which network file systems (an Azure Files mount) do not provide;
    // there the rollback journal is the safe choice. SQLITE_JOURNAL=delete selects it.
    const journal = (opts.journal || 'wal').toLowerCase() === 'delete' ? 'DELETE' : 'WAL';
    this.db.exec(`PRAGMA journal_mode = ${journal}; PRAGMA synchronous = ${journal === 'WAL' ? 'NORMAL' : 'FULL'};`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        cx INTEGER NOT NULL, cz INTEGER NOT NULL, version INTEGER NOT NULL, updated INTEGER NOT NULL, blob BLOB NOT NULL,
        PRIMARY KEY (cx, cz));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who INTEGER, type TEXT NOT NULL, x REAL, z REAL, detail TEXT);
      CREATE INDEX IF NOT EXISTS actions_at ON actions (at);
      CREATE TABLE IF NOT EXISTS players (
        token TEXT PRIMARY KEY, id INTEGER NOT NULL, name TEXT, color INTEGER, x REAL, z REAL, last_seen INTEGER NOT NULL);`);
    this.sPlayerGet = this.db.prepare('SELECT token, id, name, color, x, z, last_seen FROM players WHERE token = ?');
    this.sPlayerSet = this.db.prepare(
      'INSERT INTO players (token, id, name, color, x, z, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(token) DO UPDATE SET id = excluded.id, name = excluded.name, color = excluded.color, x = excluded.x, z = excluded.z, last_seen = excluded.last_seen');
    this.sPlayerMaxId = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM players');
    this.sChunk = this.db.prepare(
      'INSERT INTO chunks (cx, cz, version, updated, blob) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(cx, cz) DO UPDATE SET version = excluded.version, updated = excluded.updated, blob = excluded.blob');
    this.sChunks = this.db.prepare('SELECT cx, cz, version, blob FROM chunks');
    this.sGet = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    this.sSet = this.db.prepare(
      'INSERT INTO kv (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated');
    this.sAct = this.db.prepare('INSERT INTO actions (at, who, type, x, z, detail) VALUES (?, ?, ?, ?, ?, ?)');
    this.sCountChunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks');
    this.sCountActions = this.db.prepare('SELECT COUNT(*) AS n FROM actions');
  }
  saveChunks(list) { // [{cx, cz, buf: ArrayBuffer}] in one transaction
    if (!list.length) return;
    this.db.exec('BEGIN');
    try {
      const now = Date.now();
      for (const c of list) this.sChunk.run(c.cx, c.cz, 1, now, new Uint8Array(c.buf));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  loadChunks() { return this.sChunks.all(); } // rows with blob as Uint8Array
  get(key, dflt) { const r = this.sGet.get(key); return r ? JSON.parse(r.value) : dflt; }
  set(key, value) { this.sSet.run(key, JSON.stringify(value), Date.now()); }
  logAction(who, type, x, z, detail) {
    this.sAct.run(Date.now(), who == null ? null : who, type, x == null ? null : x, z == null ? null : z, detail === undefined ? null : JSON.stringify(detail));
  }
  getPlayer(token) { return this.sPlayerGet.get(token) || null; }
  savePlayer(p) { this.sPlayerSet.run(p.token, p.id, p.name || '', p.color | 0, p.x, p.z, Date.now()); }
  maxPlayerId() { return this.sPlayerMaxId.get().n; }
  stats() { return { chunks: this.sCountChunks.get().n, actions: this.sCountActions.get().n }; }
  mirror() { // consistent copy of the whole database to the mirror location; false if no mirror is configured
    if (!this.mirrorFile) return false;
    fs.mkdirSync(path.dirname(this.mirrorFile), { recursive: true });
    // SQLite must not touch the share at all (it cannot lock there), so the consistent copy is made
    // on local disk and then moved to the share with plain file operations.
    const localCopy = this.file + '.mirror', shareTmp = this.mirrorFile + '.tmp';
    fs.rmSync(localCopy, { force: true });
    this.db.exec(`VACUUM INTO '${localCopy.replace(/'/g, "''")}'`);
    fs.copyFileSync(localCopy, shareTmp);
    fs.renameSync(shareTmp, this.mirrorFile);
    fs.rmSync(localCopy, { force: true });
    return true;
  }
  close() { this.db.close(); }
}

module.exports = { Store };
