// Reading the hermes session index (~/.pi/agent/pi-hermes-memory/sessions.db).
//
// PS-TV-04 / CP-22: the query path can only hold a read-only handle. The
// DatabaseSync instance lives in a private field of ReadOnlyIndex, so a write
// from this module is unrepresentable rather than guarded by a runtime flag.
// Indexing (core/indexer.ts) opens its own writable handle; it never receives
// this one.
import { existsSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 50;
export const DEFAULT_SNIPPET_CHARS = 200;
export const MAX_SNIPPET_CHARS = 2000;

/** One ranked message hit, shaped by the tool contract (RTL-03). */
export interface SessionHit {
  session_id: string;
  cwd: string | null;
  started_at: string | null;
  role: string;
  timestamp: string | null;
  snippet: string;
  score: number;
}

/** A validated search request: every optional filter already narrowed. */
export interface SearchQuery {
  query: string;
  limit: number;
  cwd?: string;
  after?: string;
  before?: string;
  snippetChars: number;
}

export type SearchOutcome =
  | { status: "ok"; hits: SessionHit[]; note: string | null }
  | { status: "missing"; note: string }
  | { status: "error"; message: string };

/** The db hermes writes; absent on a machine that never ran hermes. */
export function defaultDbPath(homeDir: string = homedir()): string {
  return join(homeDir, ".pi", "agent", "pi-hermes-memory", "sessions.db");
}

/** The pi session transcripts the indexer reads. */
export function defaultSessionsDir(homeDir: string = homedir()): string {
  return join(homeDir, ".pi", "agent", "sessions");
}

/**
 * A read-only view of the session index. The constructor is private and the
 * sqlite handle is a #private field, so callers cannot reach a write path.
 */
export class ReadOnlyIndex {
  readonly kind = "read-only-session-index" as const;
  readonly path: string;
  readonly #db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  /** Open the db read-only by construction; throws if the file cannot be opened. */
  static open(dbPath: string): ReadOnlyIndex {
    return new ReadOnlyIndex(dbPath, new DatabaseSync(dbPath, { readOnly: true }));
  }

  /** Run one prepared statement; parameter binding only, never string splicing. */
  all(sql: string, ...params: string[]): Record<string, SQLOutputValue>[] {
    return this.#db.prepare(sql).all(...params);
  }

  close(): void {
    this.#db.close();
  }
}

/** Narrow an untyped sqlite column without pretending to a shape. */
function asString(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: SQLOutputValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Map raw tool parameters to a SearchQuery. Out-of-range numbers are clamped
 * rather than rejected: a caller asking for 500 hits wants "as many as allowed".
 */
export function toSearchQuery(raw: Record<string, unknown>): SearchQuery {
  const query = typeof raw.query === "string" ? raw.query : "";
  const limit = toInt(raw.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const snippetChars = toInt(raw.snippetChars, DEFAULT_SNIPPET_CHARS, 1, MAX_SNIPPET_CHARS);
  const q: SearchQuery = { query, limit, snippetChars };
  if (typeof raw.cwd === "string" && raw.cwd.length > 0) q.cwd = raw.cwd;
  if (typeof raw.after === "string" && raw.after.length > 0) q.after = raw.after;
  if (typeof raw.before === "string" && raw.before.length > 0) q.before = raw.before;
  return q;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The ranked query: FTS5 MATCH over message content, joined to the message and
 * session rows, ordered by bm25. bm25 is negative, so ascending order puts the
 * best hit first. String literals are single-quoted; every caller value is bound.
 */
const SEARCH_SQL_HEAD = `SELECT m.session_id AS session_id,
       s.cwd AS cwd,
       s.started_at AS started_at,
       m.role AS role,
       m.timestamp AS timestamp,
       snippet(message_fts,0,'[',']','...',32) AS snip,
       bm25(message_fts) AS score
  FROM message_fts
  JOIN messages m ON m.rowid = message_fts.rowid
  JOIN sessions s ON s.id = m.session_id`;

/** Run the ranked query against an already-open read-only index. */
export function searchIndex(index: ReadOnlyIndex, q: SearchQuery): SessionHit[] {
  const where: string[] = ["message_fts MATCH ?"];
  const params: string[] = [q.query];
  if (q.cwd !== undefined) {
    where.push("s.cwd = ?");
    params.push(q.cwd);
  }
  // Date filters compare ISO strings against sessions.started_at, which hermes
  // stores as ISO-8601, so lexicographic order is chronological order.
  if (q.after !== undefined) {
    where.push("s.started_at >= ?");
    params.push(q.after);
  }
  if (q.before !== undefined) {
    where.push("s.started_at <= ?");
    params.push(q.before);
  }
  const sql = `${SEARCH_SQL_HEAD}\n WHERE ${where.join(" AND ")}\n ORDER BY score\n LIMIT ?`;
  const rows = index.all(sql, ...params, String(q.limit));

  return rows.map((row) => ({
    session_id: asString(row.session_id) ?? "",
    cwd: asString(row.cwd),
    started_at: asString(row.started_at),
    role: asString(row.role) ?? "",
    timestamp: asString(row.timestamp),
    snippet: clipSnippet(asString(row.snip) ?? "", q.snippetChars),
    score: asNumber(row.score),
  }));
}

/** FTS5 caps snippets by tokens (32); snippetChars caps the rendered text. */
export function clipSnippet(snippet: string, snippetChars: number): string {
  if (snippet.length <= snippetChars) return snippet;
  return `${snippet.slice(0, snippetChars)}...`;
}

/**
 * Search the db at `dbPath`. A missing file is an empty result plus a note —
 * after hermes is dropped the index may simply not exist. Anything else that
 * fails (unopenable file, corrupt image, unknown schema) is an error, because
 * silence there would read as "no matches".
 */
export function searchSessions(dbPath: string, q: SearchQuery): SearchOutcome {
  if (q.query.trim().length === 0) {
    return { status: "ok", hits: [], note: "empty query" };
  }
  if (!existsSync(dbPath)) {
    return { status: "missing", note: `session index not found at ${dbPath}` };
  }

  let index: ReadOnlyIndex;
  try {
    index = ReadOnlyIndex.open(dbPath);
  } catch (err) {
    return { status: "error", message: `session index not openable at ${dbPath}: ${messageOf(err)}` };
  }

  try {
    return { status: "ok", hits: searchIndex(index, q), note: null };
  } catch (err) {
    const message = messageOf(err);
    // An unparseable MATCH expression is caller input, not a broken index:
    // report it as "nothing found, here is why" instead of an error result.
    if (isMatchSyntaxError(message)) {
      return { status: "ok", hits: [], note: `query not understood by FTS5: ${message}` };
    }
    return { status: "error", message: `session index not queryable at ${dbPath}: ${message}` };
  } finally {
    index.close();
  }
}

/** FTS5 rejects some raw input (unbalanced quotes, bare operators). */
function isMatchSyntaxError(message: string): boolean {
  return /fts5: syntax error|unterminated string|unknown special query|phrase queries are not supported/i.test(
    message
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
