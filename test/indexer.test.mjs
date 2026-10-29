// Run: node --test test/*.test.mjs
// Indexing tests: bounded per call, resumable, idempotent message ids, FTS kept
// in sync whether hermes' triggers are present or not.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_INDEX_PER_CALL, indexPendingSessions, messageId, parseSessionFile } from "../core/indexer.ts";
import { searchSessions, toSearchQuery } from "../core/db.ts";
import { makeDb, sessionLine, writeTranscript } from "./helpers.mjs";

function freshTree(t, opts) {
  const dir = mkdtempSync(join(tmpdir(), "sslite-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");
  const sessionsDir = join(dir, "sessions");
  makeDb(dbPath, opts);
  return { dir, dbPath, sessionsDir };
}

function countRows(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    return typeof row?.n === "number" ? row.n : -1;
  } finally {
    db.close();
  }
}

test("indexing stops at MAX_INDEX_PER_CALL and the next call continues", (t) => {
  const { dbPath, sessionsDir } = freshTree(t);
  for (let i = 0; i < 30; i++) {
    writeTranscript(sessionsDir, {
      id: `s-${String(i).padStart(3, "0")}`,
      cwd: `C:/proj/p${i}`,
      startedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:0${i % 10}.000Z`,
      messages: [{ role: "user", content: `transcript number ${i} about sqlite`, timestamp: "2026-04-01T00:01:00.000Z" }],
    });
  }

  const first = indexPendingSessions({ dbPath, sessionsDir });
  assert.equal(first.scanned, 30);
  assert.equal(first.indexed, MAX_INDEX_PER_CALL);
  assert.equal(first.pending, 30 - MAX_INDEX_PER_CALL);
  assert.deepEqual(first.failed, []);
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM session_files"), MAX_INDEX_PER_CALL);

  const second = indexPendingSessions({ dbPath, sessionsDir });
  assert.equal(second.indexed, 5);
  assert.equal(second.pending, 0);
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM session_files"), 30);
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM messages"), 30);

  const third = indexPendingSessions({ dbPath, sessionsDir });
  assert.equal(third.indexed, 0, "unchanged files are not re-indexed");
  assert.equal(third.pending, 0);
});

test("re-running on an unchanged file writes nothing", (t) => {
  const { dbPath, sessionsDir } = freshTree(t);
  writeTranscript(sessionsDir, {
    id: "s-one",
    cwd: "C:/proj/one",
    startedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "alpha beta gamma", timestamp: "2026-05-01T00:01:00.000Z" }],
  });
  assert.equal(indexPendingSessions({ dbPath, sessionsDir }).indexed, 1);
  assert.equal(indexPendingSessions({ dbPath, sessionsDir }).indexed, 0);
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM messages"), 1);
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM session_files"), 1);
});

test("a changed file is re-indexed and its new message becomes searchable", (t) => {
  const { dbPath, sessionsDir } = freshTree(t);
  const file = writeTranscript(sessionsDir, {
    id: "s-growth",
    cwd: "C:/proj/growth",
    startedAt: "2026-06-01T00:00:00.000Z",
    messages: [{ role: "user", content: "first message about rutabaga", timestamp: "2026-06-01T00:01:00.000Z" }],
  });
  assert.equal(indexPendingSessions({ dbPath, sessionsDir }).indexed, 1);

  // pi appends lines, so the existing message keeps its line index and only new
  // lines are added; the indexer must add the new message without duplicating
  // the old one.
  const appended = [
    sessionLine("s-growth", "C:/proj/growth", "2026-06-01T00:00:00.000Z"),
    JSON.stringify({ type: "model_change", id: "m0" }),
    JSON.stringify({
      type: "message",
      id: "x1",
      timestamp: "2026-06-01T00:01:00.000Z",
      message: { role: "user", content: "first message about rutabaga" },
    }),
    JSON.stringify({
      type: "message",
      id: "x2",
      timestamp: "2026-06-01T00:02:00.000Z",
      message: { role: "assistant", content: "second message about parsnip" },
    }),
  ].join("\n");
  writeFileSync(file, appended + "\n", "utf8");
  const size = statSync(file).size;

  const report = indexPendingSessions({ dbPath, sessionsDir });
  assert.equal(report.indexed, 1, "size change makes the file a candidate");
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM messages"), 2);

  const outcome = searchSessions(dbPath, toSearchQuery({ query: "parsnip" }));
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.hits.map((h) => h.session_id), ["s-growth"]);

  const row = new DatabaseSync(dbPath, { readOnly: true });
  const fileRow = row.prepare("SELECT size FROM session_files WHERE session_id = ?").get("s-growth");
  row.close();
  assert.equal(fileRow.size, size);
});

test("indexed content is searchable when the db has no FTS triggers", (t) => {
  const { dbPath, sessionsDir } = freshTree(t);
  writeTranscript(sessionsDir, {
    id: "s-fts",
    cwd: "C:/proj/fts",
    startedAt: "2026-07-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "the manual indexer writes fts rows itself", timestamp: "2026-07-01T00:01:00.000Z" },
    ],
  });
  indexPendingSessions({ dbPath, sessionsDir });

  const outcome = searchSessions(dbPath, toSearchQuery({ query: "indexer" }));
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.hits.length, 1);
  assert.equal(outcome.hits[0].role, "user");
  assert.equal(outcome.hits[0].cwd, "C:/proj/fts");
});

test("with hermes' FTS triggers present the indexer does not duplicate fts rows", (t) => {
  const { dbPath, sessionsDir } = freshTree(t, { triggers: true });
  writeTranscript(sessionsDir, {
    id: "s-tri",
    cwd: "C:/proj/tri",
    startedAt: "2026-08-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "trigger maintained full text row", timestamp: "2026-08-01T00:01:00.000Z" },
      { role: "assistant", content: "second message stays single", timestamp: "2026-08-01T00:02:00.000Z" },
    ],
  });
  indexPendingSessions({ dbPath, sessionsDir });

  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM messages"), 2);
  assert.equal(countRows(dbPath, "SELECT count(*) AS n FROM message_fts"), 2);
  const outcome = searchSessions(dbPath, toSearchQuery({ query: "maintained" }));
  assert.equal(outcome.hits.length, 1);
});

test("a missing db is reported and is not created by the indexer", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sslite-nodb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");
  const sessionsDir = join(dir, "sessions");

  const report = indexPendingSessions({ dbPath, sessionsDir });
  assert.equal(report.indexed, 0);
  assert.match(report.note ?? "", /not found/);
  assert.equal(existsSync(dbPath), false, "the indexer must not create a schema-less db");
});

test("parseSessionFile flattens text parts and skips thinking and tool calls", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sslite-parse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-09-01T00-00-00-000Z_s-parse.jsonl");
  const lines = [
    sessionLine("s-parse", "C:/proj/parse", "2026-09-01T00:00:00.000Z"),
    JSON.stringify({ type: "model_change", id: "m0", timestamp: "2026-09-01T00:00:01.000Z" }),
    JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: "2026-09-01T00:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "string parts are flattened" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      timestamp: "2026-09-01T00:02:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret chain of thought" },
          { type: "text", text: "first text part" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "second text part" },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "a2",
      timestamp: "2026-09-01T00:03:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
    }),
    "not json at all",
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");

  const parsed = parseSessionFile(file);
  assert.equal(parsed.sessionId, "s-parse");
  assert.equal(parsed.cwd, "C:/proj/parse");
  assert.equal(parsed.project, "parse");
  assert.equal(parsed.startedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(parsed.endedAt, "2026-09-01T00:02:00.000Z");

  assert.equal(parsed.messages.length, 2, "tool-call-only and non-message lines are skipped");
  assert.equal(parsed.messages[0].content, "string parts are flattened");
  assert.equal(parsed.messages[1].content, "first text part\nsecond text part");
  assert.equal(
    parsed.messages[1].content.includes("secret chain of thought"),
    false,
    "thinking is not evidence for search"
  );
  assert.match(parsed.messages[1].toolCalls ?? "", /"name":"bash"/);

  assert.equal(parsed.messages[0].id, messageId("s-parse", 2, "2026-09-01T00:01:00.000Z"));
  assert.deepEqual(
    parseSessionFile(file).messages.map((m) => m.id),
    parsed.messages.map((m) => m.id),
    "message ids are stable across parses"
  );
});

test("a transcript without a session line takes its id from the filename", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sslite-nosession-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-10-01T00-00-00-000Z_019f6ffd-412e-7788.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: "2026-10-01T00:01:00.000Z",
      message: { role: "user", content: "no session header here" },
    }) + "\n",
    "utf8"
  );
  const parsed = parseSessionFile(file);
  assert.equal(parsed.sessionId, "019f6ffd-412e-7788");
  assert.equal(parsed.cwd, null);
  assert.equal(parsed.project, null);
  assert.equal(parsed.startedAt, "2026-10-01T00:01:00.000Z");
});

test("messageId names its three parts so re-indexing stays idempotent", () => {
  assert.equal(messageId("s1", 0, "t"), "s1:0:t");
  assert.equal(messageId("s1", 3, null), "s1:3:unknown");
  assert.notEqual(messageId("s1", 3, "t"), messageId("s2", 3, "t"));
});
