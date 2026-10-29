// Shared fixtures for the session-search-lite tests. Not a test file: the test
// pattern is test/*.test.mjs, so this module is only ever imported.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The hermes schema, verbatim in shape: sessions/messages plain tables and
 * message_fts as an external-content FTS5 table with the trigram tokenizer.
 */
export const DDL = `
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, project TEXT, cwd TEXT, started_at TEXT,
  ended_at TEXT, message_count INT
);
CREATE TABLE messages(
  id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
  timestamp TEXT, tool_calls TEXT
);
CREATE VIRTUAL TABLE message_fts USING fts5(
  content, content='messages', content_rowid='rowid', tokenize='trigram'
);
CREATE TABLE session_files(
  path TEXT PRIMARY KEY, session_id TEXT, size INT, mtime_ms INT, indexed_at TEXT
);
`;

/** hermes keeps message_fts in sync with triggers; this is that trigger shape. */
export const FTS_TRIGGERS = `
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
`;

/** Create a db with the hermes schema. Optionally let triggers own the FTS table. */
export function makeDb(dbPath, { triggers = false } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  if (triggers) db.exec(FTS_TRIGGERS);
  db.close();
  return dbPath;
}

/**
 * Seed three sessions. The shared token "session" lives in beta and gamma only,
 * so limit/ordering tests have a known hit set.
 */
export function seedThreeSessions(dbPath, { triggers = false } = {}) {
  const db = new DatabaseSync(dbPath);
  const sessions = [
    ["s-alpha", "alpha", "C:/proj/alpha", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", 2],
    ["s-beta", "beta", "C:/proj/beta", "2026-02-01T00:00:00.000Z", "2026-02-01T01:00:00.000Z", 2],
    ["s-gamma", "gamma", "C:/proj/alpha", "2026-03-01T00:00:00.000Z", "2026-03-01T01:00:00.000Z", 2],
  ];
  const messages = [
    ["m-a1", "s-alpha", "user", "the memory governance surface is one tool", "2026-01-01T00:10:00.000Z"],
    ["m-a2", "s-alpha", "assistant", "sqlite trigram search answers quickly", "2026-01-01T00:20:00.000Z"],
    ["m-b1", "s-beta", "user", "session indexing caps at twenty five files", "2026-02-01T00:10:00.000Z"],
    ["m-b2", "s-beta", "assistant", "the transcript parses line by line", "2026-02-01T00:20:00.000Z"],
    ["m-g1", "s-gamma", "user", "banana bread recipe", "2026-03-01T00:10:00.000Z"],
    ["m-g2", "s-gamma", "assistant", "session notes about bread", "2026-03-01T00:20:00.000Z"],
  ];
  const insertSession = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?)");
  for (const row of sessions) insertSession.run(...row);
  const insertMessage = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)");
  for (const [id, sessionId, role, content, timestamp] of messages) {
    insertMessage.run(id, sessionId, role, content, timestamp, null);
  }
  // No triggers on this db, so populate the external-content FTS table by hand.
  if (!triggers) {
    db.prepare("INSERT INTO message_fts(rowid, content) SELECT rowid, content FROM messages").run();
  }
  db.close();
  return dbPath;
}

/** A pi transcript line for a user or assistant message. */
export function messageLine(index, role, content, timestamp) {
  return JSON.stringify({
    type: "message",
    id: `line${index}`,
    parentId: null,
    timestamp,
    message: { role, content },
  });
}

export function sessionLine(id, cwd, timestamp) {
  return JSON.stringify({ type: "session", version: 3, id, cwd, timestamp });
}

/**
 * Write one synthetic transcript at <root>/<project>/<stamp>_<id>.jsonl.
 * `messages` is a list of {role, content, timestamp}.
 */
export function writeTranscript(root, { id, cwd, startedAt, project = "proj", messages }) {
  const lines = [sessionLine(id, cwd, startedAt), JSON.stringify({ type: "model_change", id: "m0" })];
  messages.forEach((m, i) => lines.push(messageLine(i, m.role, m.content, m.timestamp)));
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${startedAt.replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}
