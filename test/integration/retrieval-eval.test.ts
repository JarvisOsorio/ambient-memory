import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { MemoryStore } from "../../src/store/memory-store.js";

/**
 * Realistic founder/engineer queries — top hit must be the intended doc.
 */
describe("retrieval eval fixtures", () => {
  let store: MemoryStore;
  let dataDir: string;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-eval-"));
    store = new MemoryStore(buildConfig({ dataDir, forceFileKey: true }));

    const corpus: Array<{ title: string; path: string; body: string; type?: "file" | "snippet" | "url" }> = [
      {
        title: "auth-middleware.ts",
        path: "/proj/src/auth-middleware.ts",
        body: "JWT verification middleware for the API gateway. Validates Bearer tokens.",
      },
      {
        title: "README.md",
        path: "/proj/README.md",
        body: "Ambient memory zero-config installer for Cursor MCP. Solo founders.",
      },
      {
        title: "billing.ts",
        path: "/proj/src/billing.ts",
        body: "Stripe checkout session creation and webhook handling for subscriptions.",
      },
      {
        title: "notes-on-rag.md",
        path: "/proj/docs/notes-on-rag.md",
        body: "BM25 versus dense embeddings for local retrieval. Prefer hybrid ranking.",
      },
      {
        title: "deploy.sh",
        path: "/proj/scripts/deploy.sh",
        body: "Deploy worker to Cloudflare with wrangler. Sets ENVIRONMENT=production.",
      },
      {
        title: "Model Context Protocol docs",
        path: "https://modelcontextprotocol.io",
        body: "https://modelcontextprotocol.io",
        type: "url",
      },
      {
        title: "founder note",
        path: undefined as unknown as string,
        body: "Need MCP tools so Cursor remembers my last coding session without Markdown vaults.",
        type: "snippet",
      },
    ];

    for (const doc of corpus) {
      store.upsertEntity({
        type: doc.type ?? "file",
        title: doc.title,
        path: doc.path,
        body: doc.body,
        source: "eval",
      });
    }
    // recency: touch auth-middleware as most recent
    store.upsertEntity({
      type: "file",
      title: "auth-middleware.ts",
      path: "/proj/src/auth-middleware.ts",
      body: "JWT verification middleware for the API gateway. Validates Bearer tokens.",
      source: "eval",
      seenAt: Date.now(),
    });
  });

  after(() => store.close(false));

  const cases: Array<{ q: string; expectTitle: string }> = [
    { q: "JWT bearer middleware", expectTitle: "auth-middleware.ts" },
    { q: "stripe subscriptions webhook", expectTitle: "billing.ts" },
    { q: "BM25 hybrid ranking retrieval", expectTitle: "notes-on-rag.md" },
    { q: "cloudflare wrangler deploy", expectTitle: "deploy.sh" },
    { q: "ambient memory cursor MCP founders", expectTitle: "README.md" },
    { q: "model context protocol", expectTitle: "Model Context Protocol docs" },
  ];

  for (const c of cases) {
    it(`ranks "${c.q}" → ${c.expectTitle}`, () => {
      const hits = store.search(c.q, { limit: 5 });
      assert.ok(hits.length >= 1, `no hits for ${c.q}`);
      assert.equal(hits[0]!.entity.title, c.expectTitle);
    });
  }

  it('OR multi-term "founders MCP" recalls useful docs (not empty)', () => {
    // Split-term docs: founders-only + MCP-only must BOTH be recallable
    store.upsertEntity({
      type: "file",
      title: "pitch.md",
      path: "/proj/pitch.md",
      body: "Zero-config ambient memory for solo founders. Beat GBrain setup friction.",
      source: "eval",
    });
    store.upsertEntity({
      type: "snippet",
      title: "mcp-only-note",
      body: "Wire memory_search into Cursor with MCP tools.",
      source: "eval",
    });
    const hits = store.search("founders MCP", { limit: 10 });
    assert.ok(hits.length >= 2, `expected multi-doc recall, got ${hits.length}`);
    const titles = hits.map((h) => h.entity.title);
    assert.ok(titles.includes("pitch.md"), `pitch.md missing from ${titles.join(",")}`);
    assert.ok(
      titles.includes("mcp-only-note") || titles.includes("founder note") || titles.includes("README.md"),
      `MCP-related doc missing from ${titles.join(",")}`,
    );
  });

  it("supports type + pathPrefix filters", () => {
    const hits = store.search("middleware", {
      limit: 10,
      types: ["file"],
      pathPrefix: "/proj/src",
    });
    assert.ok(hits.every((h) => h.entity.type === "file"));
    assert.ok(hits.every((h) => h.entity.path?.startsWith("/proj/src")));
  });

  it("paginates with offset", () => {
    // Single common token present across several paths via prefix match on "ts"/titles
    const page1 = store.search("ts", { limit: 2, offset: 0, types: ["file"] });
    const page2 = store.search("ts", { limit: 2, offset: 2, types: ["file"] });
    assert.ok(page1.length >= 1);
    if (page2.length > 0) {
      assert.notEqual(page2[0]!.entity.id, page1[0]!.entity.id);
    }
  });
});
