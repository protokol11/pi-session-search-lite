// Run: node --test test/*.test.mjs
// Tool contract: exactly one tool named session_search, and a result whose
// shape is asserted field by field (RTL-03) — content, isError, details.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionSearchLite, { TOOL_NAME, runSessionSearch } from "../index.ts";
import { makeDb, seedThreeSessions, writeTranscript } from "./helpers.mjs";

const HIT_FIELDS = ["cwd", "role", "score", "session_id", "snippet", "started_at", "timestamp"];

function captureTool() {
  const tools = [];
  const api = {
    registerTool(tool) {
      tools.push(tool);
    },
    on() {
      throw new Error("session-search-lite registers no hooks");
    },
  };
  sessionSearchLite(api);
  return tools;
}

function freshDeps(t) {
  const dir = mkdtempSync(join(tmpdir(), "sslite-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");
  const sessionsDir = join(dir, "sessions");
  makeDb(dbPath);
  seedThreeSessions(dbPath);
  return { dbPath, sessionsDir };
}

test("the extension declares exactly one tool, session_search", () => {
  const tools = captureTool();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, TOOL_NAME);
  assert.equal(tools[0].name, "session_search");
  assert.deepEqual(Object.keys(tools[0].parameters.properties).sort(), [
    "after",
    "before",
    "cwd",
    "limit",
    "query",
    "snippetChars",
  ]);
  assert.deepEqual(tools[0].parameters.required, ["query"]);
  assert.equal(typeof tools[0].execute, "function");
});

test("the tool result shape is fixed: content, isError, details{count, results}", async (t) => {
  const deps = freshDeps(t);
  const result = await runSessionSearch({ query: "memory", limit: 5 }, deps);

  assert.deepEqual(Object.keys(result).sort(), ["content", "details", "isError"]);
  assert.equal(result.isError, false);
  assert.deepEqual(Object.keys(result.details).sort(), ["count", "results"]);
  assert.equal(result.details.count, 1);

  const hit = result.details.results[0];
  assert.deepEqual(Object.keys(hit).sort(), HIT_FIELDS);
  assert.equal(hit.session_id, "s-alpha");
  assert.equal(hit.cwd, "C:/proj/alpha");
  assert.equal(hit.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(hit.role, "user");
  assert.equal(hit.timestamp, "2026-01-01T00:10:00.000Z");
  assert.equal(typeof hit.snippet, "string");
  assert.equal(typeof hit.score, "number");

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /session_search "memory" — 1 hit/);
  assert.match(result.content[0].text, /s-alpha \| C:\/proj\/alpha \| 2026-01-01T00:10:00.000Z \| user/);
});

test("no hits still returns the fixed shape with count 0", async (t) => {
  const deps = freshDeps(t);
  const result = await runSessionSearch({ query: "qzqzqz" }, deps);
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, { count: 0, results: [] });
  assert.deepEqual(Object.keys(result.details).sort(), ["count", "results"]);
});

test("the call indexes new transcripts and says so in content", async (t) => {
  const deps = freshDeps(t);
  writeTranscript(deps.sessionsDir, {
    id: "s-new",
    cwd: "C:/proj/new",
    startedAt: "2026-10-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "brand new transcript about kumquat", timestamp: "2026-10-01T00:01:00.000Z" },
    ],
  });

  const result = await runSessionSearch({ query: "kumquat" }, deps);
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.results.map((h) => h.session_id), ["s-new"]);
  assert.match(result.content[0].text, /note: indexed 1 transcript\(s\), 0 still pending/);
});

test("indexing is bounded per call and the bound is reported", async (t) => {
  const deps = { ...freshDeps(t), maxIndex: 1 };
  for (let i = 0; i < 3; i++) {
    writeTranscript(deps.sessionsDir, {
      id: `s-${i}`,
      cwd: `C:/proj/p${i}`,
      startedAt: `2026-11-0${i + 1}T00:00:00.000Z`,
      messages: [{ role: "user", content: `capped run ${i}`, timestamp: `2026-11-0${i + 1}T00:01:00.000Z` }],
    });
  }
  const first = await runSessionSearch({ query: "capped" }, deps);
  assert.match(first.content[0].text, /indexed 1 transcript\(s\), 2 still pending/);

  await runSessionSearch({ query: "capped" }, deps);
  const third = await runSessionSearch({ query: "capped" }, deps);
  assert.equal(third.details.count, 3, "all three are searchable after three calls");
});

test("a missing db returns an empty result with a note, not an error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sslite-tool-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await runSessionSearch(
    { query: "anything" },
    { dbPath: join(dir, "sessions.db"), sessionsDir: join(dir, "sessions") }
  );
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, { count: 0, results: [] });
  assert.match(result.content[0].text, /session index not found/);
});
