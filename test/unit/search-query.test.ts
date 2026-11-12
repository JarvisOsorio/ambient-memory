import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFtsQuery, rankScore } from "../../src/store/search.js";

describe("FTS query OR semantics", () => {
  it("joins terms with OR", () => {
    const q = buildFtsQuery("founders MCP");
    assert.match(q, /OR/);
    assert.match(q, /"founders"/);
    assert.match(q, /"mcp"\*/);
  });

  it("boosts higher term coverage", () => {
    const low = rankScore({
      bm25: -1,
      lastSeenAt: Date.now(),
      query: "founders MCP",
      title: "pitch",
      body: "solo founders beat friction",
    });
    const high = rankScore({
      bm25: -1,
      lastSeenAt: Date.now(),
      query: "founders MCP",
      title: "founder MCP note",
      body: "founders need MCP tools",
    });
    assert.ok(high > low);
  });
});
