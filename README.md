# session-search-lite

One `session_search` tool over the local SQLite index of past pi sessions, ranked by BM25.

## Table of contents

- [Why](#why)
- [Scope](#scope)
- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why

A pi session that ran last week holds the answer to a question the current
session is asking again. The transcripts sit on disk under
`~/.pi/agent/sessions`, but nothing in the harness reaches into them, so the
same investigation is repeated instead of recalled.

`session-search-lite` registers one declared tool that answers that question
from an index instead of from the context window: FTS5 trigram matching over
message text, ordered by BM25, with the session id, working directory and
timestamp on every hit so a follow-up can reopen the right transcript.

The name says what it replaces. The `hermes` memory extension ships a
`session_search` tool; this extension declares the same tool name over the same
database, so a machine that has a hermes-built index can query it without
hermes loaded. For that reason the two must not be loaded together: the pi
harness treats a duplicate tool name as fatal.

## Scope

**In scope:** one tool, `session_search`, over the hermes-shaped SQLite index;
read-only queries; bounded, incremental indexing of new or changed `*.jsonl`
transcripts; filters on session `cwd` and session start time; a fixed result
shape.

**Non-scope:** embeddings or semantic ranking; writing to or rewriting the
index schema; rendering a UI; searching anything other than pi session
transcripts and the tables listed below; replacing hermes' memory features;
pruning or deleting transcripts.

## How it works

Two paths, kept apart on purpose:

- **Read** (`core/db.ts`) opens the database with `readOnly: true`. The
  `DatabaseSync` handle is a `#private` field of `ReadOnlyIndex`, so a write
  from the query path is unrepresentable rather than blocked by a flag at
  runtime.
- **Index** (`core/indexer.ts`) opens its own writable handle, writes at most
  `MAX_INDEX_PER_CALL` (25) transcripts per tool call, and hands the handle
  back. The read path never receives it.

Every tool call runs the index pass first, then the query. A failing index pass
becomes a note in the tool output, not a failed call: history that is already
indexed stays searchable even when one transcript cannot be parsed.

Transcripts are parsed line by line. Only `type: "message"` lines count; within
a message, `text` parts are indexed, `thinking` parts are dropped, and
`toolCall` parts are stored verbatim in `messages.tool_calls` without entering
the search index. Unparseable lines are skipped, so one bad line does not cost
a whole transcript.

Message ids are derived from the file, not from the JSONL's own short ids:
`<session id>:<0-based line index>:<line timestamp or "unknown">`. Re-indexing
the same transcript therefore produces the same ids, and `INSERT OR IGNORE`
keeps indexing idempotent when a file moves.

The schema is left exactly as hermes built it (`sessions`, `messages`,
`message_fts`, `session_files`), so a hermes reinstall can still read it. If the
database has `message_fts` but no trigger keeping it in sync, the indexer writes
the FTS row itself; whether triggers exist is detected once per database.

Indexing candidates are ordered oldest mtime first with the path as tiebreak, so
an interrupted backfill resumes at the same place on the next call instead of
reshuffling.

## Install

Prerequisites:

- Node.js 24 or newer — the extension uses the `node:sqlite` `DatabaseSync` API.
- pi, with sessions under `~/.pi/agent/sessions`.
- For a non-empty index: a SQLite database at
  `~/.pi/agent/pi-hermes-memory/sessions.db` with the hermes schema. A machine
  that never ran hermes has no index, and the tool reports that instead of
  failing.

Copy the extension directory into the pi extensions folder:

```sh
cp -r session-search-lite ~/.pi/agent/extensions/session-search-lite
```

Expected: `~/.pi/agent/extensions/session-search-lite` contains `index.ts`,
`core/`, `test/` and `package.json`. Restart pi; one tool named
`session_search` is registered.

Do not load `hermes` in the same session. The harness refuses a duplicate tool
name.

## Usage

One path to one result: ask a question that a past session already answered.

In a pi session, the model calls the tool:

```
session_search query="trigram tokenizer" limit=3
```

Real output for a hit:

```
session_search "trigram tokenizer" — 1 hit(s) (limit 3)
note: indexed 2 transcript(s), 0 still pending
- 9f2c1d84-6a0e-4b3a-9a67-2f9c1c7e55aa | C:/Users/HOME/proj/agent-governance | 2026-10-02T08:14:11.402Z | assistant | score -1.8703
  the FTS5 index uses tokenize='trigram' so substring matches inside a word still return the message
```

Narrow it to one project and one month:

```
session_search query="index bounded per call" cwd="C:/Users/HOME/proj/agent-governance" after="2026-10-01T00:00:00.000Z"
```

Three details worth knowing when reading the output:

- `score` is the raw `bm25()` value, which is negative; lower is better, and the
  list is already sorted that way.
- A line beginning `note:` is informational. It says what indexing did, or why
  indexing did not run.
- Empty results are a normal answer, not an error: `isError` stays `false` and
  `count` is `0`. When there is a reason to give — a missing index, an
  unparseable query — a `note:` line states it.

## Tools

The extension registers exactly one tool and no commands or hooks.

`session_search` — search message text in the session index.

| Parameter | Type | Default | Effect |
|---|---|---|---|
| `query` | string, required | — | Text to match through FTS5 trigram. |
| `limit` | number | 5 (max 50) | Hits returned. Out-of-range values are clamped, not rejected. |
| `cwd` | string | unset | Exact match on the session's working directory. |
| `after` | string (ISO) | unset | Only sessions with `started_at >= after`. |
| `before` | string (ISO) | unset | Only sessions with `started_at <= before`. |
| `snippetChars` | number | 200 (max 2000) | Maximum characters of each rendered snippet. |

Result shape, fixed:

```
{
  content: [{ type: "text", text: "..." }],
  isError: boolean,
  details: {
    count: number,
    results: [{
      session_id: string,
      cwd: string | null,
      started_at: string | null,
      role: string,
      timestamp: string | null,
      snippet: string,
      score: number
    }]
  }
}
```

Each call also indexes up to 25 new or changed transcripts before it queries,
and reports the counts in `content`. A first call on a large history returns
fewer hits than exist; the next call has indexed the next 25 files.

## Configuration

The extension reads no environment variables and has no config file. Shown for
completeness, the two paths are derived from the home directory:

| Setting | Default | Effect |
|---|---|---|
| Session index database | `~/.pi/agent/pi-hermes-memory/sessions.db` | Read by the tool, written by the index pass. Never created by this extension. |
| Session transcripts | `~/.pi/agent/sessions` | Every `*.jsonl` under this directory, at any depth, is an indexing candidate. |
| Files indexed per call | 25 (`MAX_INDEX_PER_CALL`) | Bound on the index pass; the rest stays pending for the next call. |
| Default / maximum limit | 5 / 50 | Hit count bounds. |
| Default / maximum snippet | 200 / 2000 characters | Rendered snippet bounds. |

When the index pass runs, it also writes rows into `session_files` (`path`,
`session_id`, `size`, `mtime_ms`, `indexed_at`), which is how the next call
knows which transcripts changed. Nothing else in the database is modified.

## Troubleshooting

- **Symptom:** every call ends with `note: session index not found at
  ~/.pi/agent/pi-hermes-memory/sessions.db`, `count` is 0. **Cause:** the
  hermes-built index does not exist. **Fix:** none inside this extension — it
  deliberately does not create the file, because an empty database with no
  schema is worse than no database. Install hermes once to build the index, or
  accept zero results.
- **Symptom:** `note: session index schema not recognised; indexing skipped`.
  **Cause:** the database exists but lacks `session_files` or `messages`.
  **Fix:** point the tool at a hermes-generated index; this extension does not
  migrate schemas.
- **Symptom:** `isError: true` with `session index not openable` or `session
  index not queryable`. **Cause:** the file is not a readable SQLite database,
  or the query failed for a reason other than syntax. **Fix:** check the file
  with `sqlite3 sessions.db 'PRAGMA integrity_check;'`. A silent empty result
  here would read as "no matches", so it is reported as an error instead.
- **Symptom:** `note: query not understood by FTS5: ...`. **Cause:** the query
  string holds an unbalanced quote or a bare FTS operator. **Fix:** quote the
  phrase, or drop the operator. This is reported as zero hits plus a note, since
  the input, not the index, is at fault.
- **Symptom:** a freshly written transcript is not in the results. **Cause:** the
  index pass is bounded, and the file is still queued. **Fix:** read the `still
  pending` count in the note and call again; each call takes 25 more.
- **Symptom:** one transcript never becomes searchable while others do.
  **Cause:** writing it failed; the note names the file and the error. **Fix:**
  read the file to confirm it is valid JSONL. The file stays pending and is
  retried on a later call.
- **Symptom:** the harness refuses to start. **Cause:** hermes is loaded in the
  same session and both declare `session_search`. **Fix:** disable one of them.

## Contributing

File issues in the `agent-governance` monorepo under
`extensions/session-search-lite`: <https://github.com/protokol11/agent-governance/issues>.

Install the dev dependencies once, then run the suite:

```sh
npm install
node --test test/*.test.mjs
```

The suite is headless: `test/db.test.mjs` and `test/indexer.test.mjs` build
throwaway SQLite databases, and `test/tool.test.mjs` boots the extension against
a stub API, so no pi runtime is needed. `test/tool.test.mjs` imports `index.ts`,
which imports `typebox` at runtime; without `npm install` that file fails to
resolve its module while the other two still pass.

## License

[MIT](../../LICENSE)
