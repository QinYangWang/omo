"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");

class EventStore {
  constructor(dataDir, retention = 100_000) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "omo.db"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.retention = retention;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.insert = this.db.prepare(`
      INSERT INTO session_events(session_id, sequence, event_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.latest = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS value FROM session_events WHERE session_id = ?"
    );
    this.after = this.db.prepare(
      "SELECT * FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?"
    );
    this.trim = this.db.prepare(
      "DELETE FROM session_events WHERE session_id = ? AND sequence <= ?"
    );
    this.getRequest = this.db.prepare(
      "SELECT result FROM requests WHERE request_id = ?"
    );
    this.putRequest = this.db.prepare(
      "INSERT OR REPLACE INTO requests(request_id, result, created_at) VALUES (?, ?, ?)"
    );
  }

  append(sessionId, payload) {
    const sequence = Number(this.latest.get(sessionId).value) + 1;
    const record = {
      id: crypto.randomUUID(),
      payload,
      sequence,
      sessionId,
      timestamp: Date.now(),
      type: payload?.type || "unknown",
    };
    this.insert.run(
      sessionId,
      sequence,
      record.id,
      record.type,
      JSON.stringify(payload),
      record.timestamp
    );
    if (sequence > this.retention && sequence % 1000 === 0) {
      this.trim.run(sessionId, sequence - this.retention);
    }
    this.emitter.emit(sessionId, record);
    return record;
  }

  latestSequence(sessionId) {
    return Number(this.latest.get(sessionId).value);
  }

  list(sessionId, after = 0, limit = 5000) {
    return this.after.all(sessionId, after, limit).map((row) => ({
      id: row.event_id,
      payload: JSON.parse(row.payload),
      sequence: row.sequence,
      sessionId: row.session_id,
      timestamp: row.created_at,
      type: row.type,
    }));
  }

  subscribe(sessionId, callback) {
    this.emitter.on(sessionId, callback);
    return () => this.emitter.off(sessionId, callback);
  }

  requestResult(requestId) {
    const row = this.getRequest.get(requestId);
    return row ? JSON.parse(row.result) : undefined;
  }

  saveRequest(requestId, result) {
    this.putRequest.run(requestId, JSON.stringify(result), Date.now());
  }
}

module.exports = { EventStore };
