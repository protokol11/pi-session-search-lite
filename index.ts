// session-search-lite — replaces hermes' `session_search` with one declared
// tool over the SQLite index hermes already built (spec-1, vendored variant).
//
// Two paths, kept apart on purpose (PS-TV-04):
//   read  — core/db.ts opens the db with readOnly: true and can only query;
//   index — core/indexer.ts opens its own writable handle, bounded per call.
//
// The tool name is `session_search`; it must not be loaded while hermes is
// active, because the harness treats a duplicate tool name as fatal.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_LIMIT,
  DEFAULT_SNIPPET_CHARS,
  MAX_LIMIT,
  MAX_SNIPPET_CHARS,
  defaultDbPath,
  defaultSessionsDir,
  searchSessions,
  toSearchQuery,
} from "./core/db.ts";
import { MAX_INDEX_PER_CALL, describeIndexReport, indexPendingSessions } from "./core/indexer.ts";
import { buildToolResult, type SessionSearchResult } from "./core/render.ts";

export const TOOL_NAME = "session_search";

/** Paths the tool works on; a parameter so tests never touch the real db. */
export interface SearchDeps {
  dbPath: string;
  sessionsDir: string;
  /** Indexing bound per call; defaults to MAX_INDEX_PER_CALL. */
  maxIndex?: number;
}

export function defaultDeps(homeDir?: string): SearchDeps {
  return { dbPath: defaultDbPath(homeDir), sessionsDir: defaultSessionsDir(homeDir) };
}

/**
 * Index (bounded), then search. A failing index pass degrades to a note: the
 * existing index still answers the query, and a broken transcript should not
 * hide history that is already indexed.
 */
export async function runSessionSearch(
  raw: Record<string, unknown>,
  deps: SearchDeps
): Promise<SessionSearchResult> {
  const q = toSearchQuery(raw);
  const notes: string[] = [];

  try {
    const report = indexPendingSessions({
      dbPath: deps.dbPath,
      sessionsDir: deps.sessionsDir,
      max: deps.maxIndex,
    });
    const line = describeIndexReport(report);
    if (line) notes.push(line);
  } catch (err) {
    notes.push(`indexing skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return buildToolResult(searchSessions(deps.dbPath, q), q, notes);
}

export default function sessionSearchLite(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Session search",
    description:
      "Search past pi sessions by text, ranked by BM25 over the local SQLite index. " +
      "Returns {count, results} where each result is " +
      "{session_id, cwd, started_at, role, timestamp, snippet, score} (score is negative, " +
      "lower is better). Filters: cwd (exact match on the session's working directory), " +
      "after/before (ISO timestamps against the session start). New transcripts are indexed " +
      `up to ${MAX_INDEX_PER_CALL} files per call.`,
    parameters: Type.Object({
      query: Type.String({ description: "Text to look for; FTS5 trigram match" }),
      limit: Type.Optional(
        Type.Number({ description: `Max hits returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` })
      ),
      cwd: Type.Optional(
        Type.String({ description: "Exact session cwd filter, as returned by a previous hit" })
      ),
      after: Type.Optional(Type.String({ description: "Only sessions started at/after this ISO timestamp" })),
      before: Type.Optional(Type.String({ description: "Only sessions started at/before this ISO timestamp" })),
      snippetChars: Type.Optional(
        Type.Number({
          description: `Max characters of each snippet (default ${DEFAULT_SNIPPET_CHARS}, max ${MAX_SNIPPET_CHARS})`,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return runSessionSearch(params as Record<string, unknown>, defaultDeps());
    },
  });
}
