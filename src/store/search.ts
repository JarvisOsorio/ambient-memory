/** FTS5 query helpers + ranking boosts. */

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 64)
    .slice(0, 200);
}

/**
 * Build an FTS5 MATCH query with OR (SHOULD-like) semantics so multi-concept
 * queries like "founders MCP" recall docs matching any term. Last term gets
 * a prefix match for typeahead. Ranking later boosts higher term coverage.
 */
export function buildFtsQuery(raw: string): string {
  const terms = tokenize(raw)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => !["and", "or", "not", "near"].includes(t));
  if (terms.length === 0) return "";
  return terms
    .map((t, i) => {
      const safe = `"${t}"`;
      return i === terms.length - 1 ? `${safe}*` : safe;
    })
    .join(" OR ");
}

/**
 * Combine FTS BM25 (lower/more-negative is better) with recency, path, and
 * multi-term coverage boosts. Returns a higher-is-better final score.
 */
export function rankScore(opts: {
  bm25: number;
  lastSeenAt: number;
  now?: number;
  path?: string;
  query?: string;
  matchedTerms?: string[];
  title?: string;
  body?: string;
}): number {
  const now = opts.now ?? Date.now();
  const textScore = Math.max(0, 12 + opts.bm25);
  const ageHours = Math.max(0, (now - opts.lastSeenAt) / 3_600_000);
  const recency = 4 / (1 + ageHours / 6);

  let pathBoost = 0;
  if (opts.path && opts.query) {
    const q = opts.query.toLowerCase();
    const p = opts.path.toLowerCase();
    if (p.includes(q.replace(/\s+/g, ""))) pathBoost += 2;
    for (const t of tokenize(opts.query)) {
      if (p.includes(t)) pathBoost += 0.35;
    }
  }

  // Coverage: prefer docs matching more distinct query terms (best-fields feel)
  const queryTerms = opts.query ? tokenize(opts.query) : [];
  let coverage = 0;
  if (queryTerms.length > 0) {
    const hay = `${opts.title ?? ""} ${opts.body ?? ""} ${opts.path ?? ""}`.toLowerCase();
    const matched = queryTerms.filter((t) => hay.includes(t));
    coverage = (matched.length / queryTerms.length) * 5;
    // Extra nudge when title alone covers a term
    const title = (opts.title ?? "").toLowerCase();
    for (const t of matched) {
      if (title.includes(t)) coverage += 0.4;
    }
  }

  return textScore + recency + pathBoost + coverage;
}
