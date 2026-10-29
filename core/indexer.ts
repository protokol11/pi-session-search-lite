// Bounded lazy indexing of pi session transcripts into the hermes-shaped db.
//
// The db stays exactly as hermes built it (sessions, messages, message_fts,
// session_files), so a hermes reinstall could still read it. Indexing runs
// before a query, covers at most MAX_INDEX_PER_CALL new-or-changed files, and
// continues on the next call — an unbounded first-call backfill would outlast
// the harness timeout.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

/** Files indexed per tool call; the remainder waits for the next call. */
export const MAX_INDEX_PER_CALL = 25;

export interface IndexReport {
  /** JSONL files found under the sessions dir. */
  scanned: number;
  /** New-or-changed files still waiting after this call. */
  pending: number;
  /** Files written in this call. */
  indexed: number;
  /** Files that failed to parse or write (retried on a later call). */
  failed: string[];
  /** Why indexing did not run, when it could not. */
  note: string | null;
}

export interface ParsedMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string | null;
  toolCalls: string | null;
}

export interface ParsedSession {
  sessionId: string;
  cwd: string | null;
  project: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messages: ParsedMessage[];
}

/**
 * The JSONL carries its own short message ids (`"id":"4d164e09"`), but they are
 * only unique inside one transcript. The index needs a db-wide key, so it uses:
 *
 *   <session id>:<0-based line index>:<line timestamp or "unknown">
 *
 * All three parts come from the file itself, so re-indexing the same transcript
 * yields the same ids and INSERT OR IGNORE stays idempotent — moving a file does
 * not duplicate its messages.
 */
export function messageId(sessionId: string, lineIndex: number, timestamp: string | null): string {
  return `${sessionId}:${lineIndex}:${timestamp ?? "unknown"}`;
}

/**
 * Flatten one pi `message` line into searchable text. Content is either a
 * string, or an array of parts; only `text` parts are evidence for search —
 * `thinking` and `toolCall` parts are not shown to the user and would pollute
 * the index. Tool-call parts are kept verbatim in the `tool_calls` column.
 */
function flattenContent(content: unknown): { text: string; toolCalls: string | null } {
  if (typeof content === "string") return { text: content, toolCalls: null };
  if (!Array.isArray(content)) return { text: "", toolCalls: null };
  const texts: string[] = [];
  const calls: unknown[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; text?: unknown; [k: string]: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      texts.push(p.text);
    } else if (p.type === "toolCall") {
      calls.push(p);
    }
  }
  return { text: texts.join("\n"), toolCalls: calls.length ? JSON.stringify(calls) : null };
}

/** Derive a session id from `2026-07-17T12-11-36-110Z_<uuid>.jsonl`. */
export function sessionIdFromPath(filePath: string): string {
  const stem = basename(filePath, extname(filePath));
  const cut = stem.lastIndexOf("_");
  return cut >= 0 ? stem.slice(cut + 1) : stem;
}

/**
 * Parse a pi transcript. Non-message lines (session, model_change, …) are
 * skipped; unparseable lines are skipped, not fatal — one bad line must not
 * cost the whole transcript.
 */
export function parseSessionFile(filePath: string, text?: string): ParsedSession {
  const raw = text ?? readFileSync(filePath, "utf8");
  const lines = raw.split("\n");

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let startedAt: string | null = null;
  const messages: ParsedMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
      cwd?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;

    if (record.type === "session") {
      if (typeof record.id === "string") sessionId = record.id;
      if (typeof record.cwd === "string") cwd = record.cwd;
      if (timestamp !== null) startedAt = timestamp;
      continue;
    }
    if (record.type !== "message") continue;

    const msg = record.message;
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : null;
    if (role === null) continue;
    const { text: content, toolCalls } = flattenContent(msg.content);
    // An empty content row can never match a MATCH query; skip it rather than
    // inflate message_count with rows that carry no evidence.
    if (content.trim().length === 0) continue;

    const id = sessionId ?? sessionIdFromPath(filePath);
    messages.push({ id: messageId(id, i, timestamp), role, content, timestamp, toolCalls });
  }

  const id = sessionId ?? sessionIdFromPath(filePath);
  const firstTimestamp = messages.find((m) => m.timestamp !== null)?.timestamp ?? null;
  const lastTimestamp = [...messages].reverse().find((m) => m.timestamp !== null)?.timestamp ?? null;
  const start = startedAt ?? firstTimestamp;

  return {
    sessionId: id,
    cwd,
    project: cwd ? basename(cwd) : null,
    startedAt: start,
    endedAt: lastTimestamp ?? start,
    messages,
  };
}

/** Every `*.jsonl` under the sessions dir, at any depth. */
export function listSessionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable subdirectory is skipped, not fatal
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Lookup key for session_files.path; Windows paths are case-insensitive. */
function pathKey(p: string): string {
  return resolve(p).toLowerCase();
}

interface IndexedFileRow {
  size: number;
  mtimeMs: number;
}

function readIndexedFiles(db: DatabaseSync): Map<string, IndexedFileRow> {
  const rows = db.prepare("SELECT path, size, mtime_ms FROM session_files").all();
  const map = new Map<string, IndexedFileRow>();
  for (const row of rows) {
    const path = typeof row.path === "string" ? row.path : null;
    if (path === null) continue;
    map.set(pathKey(path), {
      size: typeof row.size === "number" ? row.size : -1,
      mtimeMs: typeof row.mtime_ms === "number" ? row.mtime_ms : -1,
    });
  }
  return map;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name);
  return typeof row?.n === "number" && row.n > 0;
}

/**
 * hermes' db keeps message_fts in sync with triggers. If a db has the table but
 * no trigger, inserting into messages alone would leave the text unsearchable,
 * so the indexer writes the FTS row itself. Detected per db, never per row.
 */
function needsManualFts(db: DatabaseSync): boolean {
  if (!tableExists(db, "message_fts")) return false;
  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'")
    .get();
  return typeof row?.n === "number" && row.n === 0;
}

function rowIdOf(db: DatabaseSync, messageIdValue: string): number | null {
  const row: Record<string, SQLOutputValue> | undefined = db
    .prepare("SELECT rowid AS rid FROM messages WHERE id = ?")
    .get(messageIdValue);
  const rid = row?.rid;
  return typeof rid === "number" ? rid : null;
}

/** Write one parsed transcript; caller owns the transaction. */
function writeSession(db: DatabaseSync, session: ParsedSession, manualFts: boolean): void {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count) VALUES (?,?,?,?,?,?)"
  ).run(
    session.sessionId,
    session.project,
    session.cwd,
    session.startedAt,
    session.endedAt,
    session.messages.length
  );

  const insertMessage = db.prepare(
    "INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls) VALUES (?,?,?,?,?,?)"
  );
  const insertFts = manualFts ? db.prepare("INSERT INTO message_fts (rowid, content) VALUES (?,?)") : null;

  for (const message of session.messages) {
    const result = insertMessage.run(
      message.id,
      session.sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCalls
    );
    // Only a row this call actually inserted needs an FTS row; changes === 0
    // means INSERT OR IGNORE skipped a duplicate and the FTS row already exists.
    if (insertFts !== null && result.changes > 0) {
      const rid = rowIdOf(db, message.id);
      if (rid !== null) insertFts.run(rid, message.content);
    }
  }
}

/**
 * Index at most `max` new-or-changed transcripts. Failures are reported and
 * retried on a later call: a file with no session_files row stays pending.
 * Throws only if the db itself cannot be opened, so the caller can decide
 * whether a broken index blocks the search.
 */
export function indexPendingSessions(opts: {
  dbPath: string;
  sessionsDir: string;
  max?: number;
}): IndexReport {
  const max = opts.max ?? MAX_INDEX_PER_CALL;
  const report: IndexReport = { scanned: 0, pending: 0, indexed: 0, failed: [], note: null };

  // A missing db is left missing: opening it writable would create an empty
  // file with no schema, which is worse than having no index at all.
  if (!existsSync(opts.dbPath)) {
    report.note = `session index not found at ${opts.dbPath}; nothing indexed`;
    return report;
  }

  const files = listSessionFiles(opts.sessionsDir);
  report.scanned = files.length;

  const db = new DatabaseSync(opts.dbPath);
  try {
    if (!tableExists(db, "session_files") || !tableExists(db, "messages")) {
      report.note = "session index schema not recognised; indexing skipped";
      return report;
    }
    const indexed = readIndexedFiles(db);
    const manualFts = needsManualFts(db);

    const candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const file of files) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue; // vanished between listing and stat
      }
      const known = indexed.get(pathKey(file));
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue;
      candidates.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // Oldest first, path as tiebreak: a deterministic order means an interrupted
    // backfill resumes at the same place instead of reshuffling.
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const batch = candidates.slice(0, Math.max(0, max));
    report.pending = candidates.length - batch.length;

    const stamp = new Date().toISOString();
    const markIndexed = db.prepare(
      "INSERT OR REPLACE INTO session_files (path, session_id, size, mtime_ms, indexed_at) VALUES (?,?,?,?,?)"
    );

    for (const file of batch) {
      try {
        const session = parseSessionFile(file.path);
        db.exec("BEGIN");
        try {
          writeSession(db, session, manualFts);
          markIndexed.run(resolve(file.path), session.sessionId, file.size, file.mtimeMs, stamp);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        report.indexed++;
      } catch (err) {
        report.failed.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    db.close();
  }
  return report;
}

/** One-line summary for the tool's content text; empty when nothing happened. */
export function describeIndexReport(report: IndexReport): string {
  if (report.note !== null) return report.note;
  if (report.failed.length > 0) {
    const first = report.failed[0];
    return `indexed ${report.indexed} transcript(s), ${report.failed.length} failed (${first})${
      report.pending > 0 ? `, ${report.pending} still pending` : ""
    }`;
  }
  if (report.indexed === 0 && report.pending === 0) return "";
  return `indexed ${report.indexed} transcript(s), ${report.pending} still pending`;
}
