// Tool result shaping: one place that turns a SearchOutcome into the fixed
// { content, isError, details } shape the tool contract promises (RTL-03).
// Kept out of index.ts so the contract can be tested without booting the pi
// runtime, and so every note (missing index, skipped files) lands in `content`
// rather than being swallowed.
import type { SearchOutcome, SearchQuery, SessionHit } from "./db.ts";

export interface SessionSearchDetails {
  count: number;
  results: SessionHit[];
}

export interface SessionSearchResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  details: SessionSearchDetails;
}

/**
 * @param notes non-fatal messages worth showing (indexing progress, skipped
 *              transcripts). They go into `content`; `details` stays exactly
 *              {count, results} so callers can rely on the shape.
 */
export function buildToolResult(
  outcome: SearchOutcome,
  q: SearchQuery,
  notes: string[] = []
): SessionSearchResult {
  if (outcome.status === "error") {
    return {
      content: [{ type: "text", text: outcome.message }],
      isError: true,
      details: { count: 0, results: [] },
    };
  }

  if (outcome.status === "missing") {
    return {
      content: [{ type: "text", text: `${outcome.note}. No session index to search; 0 results.` }],
      isError: false,
      details: { count: 0, results: [] },
    };
  }

  const extras: string[] = [];
  if (outcome.note !== null) extras.push(outcome.note);
  extras.push(...notes);

  const header = `session_search "${q.query}" — ${outcome.hits.length} hit(s) (limit ${q.limit})`;
  const body = outcome.hits.map(renderHit).join("\n");
  const lines = [header, ...extras.map((n) => `note: ${n}`)];
  if (body) lines.push(body);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: false,
    details: { count: outcome.hits.length, results: outcome.hits },
  };
}

/** `- <session id> | <cwd> | <timestamp> | <role> | score <bm25>` */
function renderHit(hit: SessionHit): string {
  const head = [
    hit.session_id,
    hit.cwd ?? "(no cwd)",
    hit.timestamp ?? "(no timestamp)",
    hit.role,
    `score ${hit.score.toFixed(4)}`,
  ].join(" | ");
  const snippet = hit.snippet.replace(/\s+/g, " ").trim();
  return `- ${head}\n  ${snippet}`;
}
