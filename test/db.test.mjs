// Run: node --test test/*.test.mjs
// Contract tests for the read path: ranked MATCH query, fixed hit shape, the
// missing-db vs corrupt-db split, and the read-only guarantee (PS-TV-04).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LIMIT,
  DEFAULT_SNIPPET_CHARS,
  MAX_LIMIT,
  ReadOnlyIndex,
  searchSessions,
  toSearchQuery,
} from "../core/db.ts";
import { buildToolResult } from "../core/render.ts";
import { makeDb, seedThreeSessions } from "./helpers.mjs";

const HIT_FIELDS = ["cwd", "role", "score", "session_id", "snippet", "started_at", "timestamp"];

function freshDb(t, opts) {
  const dir = mkdtempSync(join(tmpdir(), "sslite-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");
  makeDb(dbPath, opts);
  seedThreeSessions(dbPath, opts);
  return dbPath;
}

function q(overrides = {}) {
  return toSearchQuery({ query: "session", ...overrides });
}

test("a MATCH returns ranked hits with the full contract shape (RTL-03)", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ query: "memory" }));
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.hits.length, 1);

  const hit = outcome.hits[0];
  assert.deepEqual(Object.keys(hit).sort(), HIT_FIELDS);
  assert.equal(hit.session_id, "s-alpha");
  assert.equal(hit.cwd, "C:/proj/alpha");
  assert.equal(hit.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(hit.role, "user");
  assert.equal(hit.timestamp, "2026-01-01T00:10:00.000Z");
  // The trigram tokenizer counts ~3-character tokens, so the SQL snippet's
  // 32-token window lands near 34 characters and ends with the suffix marker.
  assert.match(hit.snippet, /^the \[memory\] governance surface/);
  assert.ok(hit.snippet.endsWith("..."));
  assert.equal(typeof hit.score, "number");
  assert.ok(hit.score < 0, "bm25 is negative and lower is better");
});

test("the snippet marks the matched term with the requested delimiters", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ query: "banana" }));
  assert.equal(outcome.status, "ok");
  assert.match(outcome.hits[0].snippet, /\[banana\]/);
});

test("limit caps the hit list and count follows the hits", (t) => {
  const dbPath = freshDb(t);
  const all = searchSessions(dbPath, q({ limit: MAX_LIMIT }));
  assert.equal(all.status, "ok");
  assert.deepEqual(
    all.hits.map((h) => h.session_id).sort(),
    ["s-beta", "s-gamma"]
  );

  const one = searchSessions(dbPath, q({ limit: 1 }));
  assert.equal(one.status, "ok");
  assert.equal(one.hits.length, 1);
});

test("cwd filters on an exact sessions.cwd match", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ cwd: "C:/proj/alpha" }));
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.hits.map((h) => h.session_id), ["s-gamma"]);

  const nearMiss = searchSessions(dbPath, q({ cwd: "C:/proj/alph" }));
  assert.equal(nearMiss.status, "ok");
  assert.equal(nearMiss.hits.length, 0, "cwd is exact, not a prefix match");
});

test("after/before compare sessions.started_at as ISO strings", (t) => {
  const dbPath = freshDb(t);
  const after = searchSessions(dbPath, q({ after: "2026-02-15T00:00:00.000Z" }));
  assert.equal(after.status, "ok");
  assert.deepEqual(after.hits.map((h) => h.session_id), ["s-gamma"]);

  const before = searchSessions(dbPath, q({ before: "2026-02-15T00:00:00.000Z" }));
  assert.equal(before.status, "ok");
  assert.deepEqual(before.hits.map((h) => h.session_id), ["s-beta"]);

  const window = searchSessions(
    dbPath,
    q({ after: "2026-01-15T00:00:00.000Z", before: "2026-02-15T00:00:00.000Z" })
  );
  assert.equal(window.status, "ok");
  assert.deepEqual(window.hits.map((h) => h.session_id), ["s-beta"]);
});

test("an unmatched term is count 0, empty list, isError false", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ query: "zzzqxyz" }));
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.hits, []);

  const result = buildToolResult(outcome, q({ query: "zzzqxyz" }));
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, { count: 0, results: [] });
});

test("an unparseable MATCH expression is a note, not an error result", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ query: '"unterminated' }));
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.hits, []);
  assert.match(outcome.note ?? "", /not understood by FTS5|syntax/);

  const result = buildToolResult(outcome, q({ query: '"unterminated' }));
  assert.equal(result.isError, false);
});

test("an empty query returns count 0 without touching the db", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ query: "   " }));
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.hits.length, 0);
  assert.equal(outcome.note, "empty query");
});

test("a missing db is an empty result with a note, isError false", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sslite-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");

  const outcome = searchSessions(dbPath, q());
  assert.equal(outcome.status, "missing");
  assert.match(outcome.note, /not found/);

  const result = buildToolResult(outcome, q());
  assert.equal(result.isError, false);
  assert.equal(result.details.count, 0);
  assert.deepEqual(result.details.results, []);
  assert.match(result.content[0].text, /No session index to search/);
});

test("a corrupt db is an error result", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sslite-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");
  writeFileSync(dbPath, "this is not a database".repeat(64), "utf8");

  const outcome = searchSessions(dbPath, q());
  assert.equal(outcome.status, "error");
  const result = buildToolResult(outcome, q());
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { count: 0, results: [] });
});

test("snippetChars truncates the rendered snippet", (t) => {
  const dbPath = freshDb(t);
  const outcome = searchSessions(dbPath, q({ query: "memory", snippetChars: 10 }));
  assert.equal(outcome.status, "ok");
  const snippet = outcome.hits[0].snippet;
  assert.equal(snippet.length, 13);
  assert.ok(snippet.endsWith("..."));
  assert.ok("the [memor".startsWith(snippet.slice(0, 10)));
});

test("toSearchQuery clamps limit and snippetChars instead of rejecting", () => {
  assert.equal(toSearchQuery({ query: "x" }).limit, DEFAULT_LIMIT);
  assert.equal(toSearchQuery({ query: "x" }).snippetChars, DEFAULT_SNIPPET_CHARS);
  assert.equal(toSearchQuery({ query: "x", limit: 500 }).limit, MAX_LIMIT);
  assert.equal(toSearchQuery({ query: "x", limit: -3 }).limit, 1);
  assert.equal(toSearchQuery({ query: "x", limit: Number.NaN }).limit, DEFAULT_LIMIT);
  assert.equal(toSearchQuery({ query: "x", snippetChars: 99999 }).snippetChars, 2000);
  assert.deepEqual(toSearchQuery({ query: "x", cwd: "", after: "", before: "" }), {
    query: "x",
    limit: DEFAULT_LIMIT,
    snippetChars: DEFAULT_SNIPPET_CHARS,
  });
  assert.equal(toSearchQuery({ query: 42 }).query, "");
});

test("PS-TV-04: the query handle exposes no write path and opens readOnly", () => {
  // The compile-time guarantee is the private constructor + #db field; this
  // asserts the surface at runtime, and greps the one open call in the source.
  const proto = Object.getOwnPropertyNames(ReadOnlyIndex.prototype);
  for (const name of proto) {
    assert.match(name, /^(constructor|all|close|kind|path)$/, `unexpected member ${name}`);
  }
  const source = readFileSync(new URL("../core/db.ts", import.meta.url), "utf8");
  assert.match(source, /new DatabaseSync\(dbPath, \{ readOnly: true \}\)/);
});
