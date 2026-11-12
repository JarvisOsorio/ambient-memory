import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { createMcpHandlers } from "../../src/mcp/server.js";
import { MCP_PROMPTS, MCP_TOOLS } from "../../src/mcp/tools.js";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("MCP v0.2 tools", () => {
  let store: MemoryStore;
  let mcp: ReturnType<typeof createMcpHandlers>;

  before(() => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-mcp2-"));
    store = new MemoryStore(buildConfig({ dataDir, forceFileKey: true }));
    const a = store.upsertEntity({
      type: "file",
      title: "gateway.ts",
      path: "/app/gateway.ts",
      body: "API gateway routes and rate limits",
    })!;
    const b = store.upsertEntity({
      type: "session",
      title: "Cursor: gateway.ts",
      body: "editing",
    })!;
    store.relate(a.id, b.id, "opened_during");
    mcp = createMcpHandlers(store);
  });

  after(() => store.close(false));

  it("exposes expanded tool + prompt catalogs", () => {
    assert.ok(MCP_TOOLS.length >= 6);
    assert.ok(MCP_TOOLS.some((t) => t.name === "memory_get"));
    assert.ok(MCP_TOOLS.some((t) => t.name === "memory_context"));
    assert.ok(MCP_PROMPTS.length >= 2);
    assert.equal(mcp.listTools().length, MCP_TOOLS.length);
  });

  it("memory_get returns entity + links", () => {
    const id = store.recent(1)[0]!.id;
    const res = mcp.callTool("memory_get", { id });
    assert.equal(res.isError, undefined);
    const body = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      entity: { id: string };
      links: unknown[];
    };
    assert.equal(body.ok, true);
    assert.equal(body.entity.id, id);
    assert.ok(Array.isArray(body.links));
  });

  it("memory_get errors clearly on missing id", () => {
    const res = mcp.callTool("memory_get", { id: "doesnotexist999" });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0]!.text) as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  });

  it("memory_search returns latency + stable shape", () => {
    const res = mcp.callTool("memory_search", {
      query: "gateway rate limits",
      limit: 5,
      types: ["file"],
    });
    const body = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      hits: Array<{ id: string; score: number }>;
      latencyMs: number;
    };
    assert.equal(body.ok, true);
    assert.ok(body.hits.length >= 1);
    assert.ok(typeof body.latencyMs === "number");
  });

  it("memory_context returns narrative", () => {
    const res = mcp.callTool("memory_context", { minutes: 60 });
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; narrative: string };
    assert.equal(body.ok, true);
    assert.ok(body.narrative.length > 10);
  });

  it("prompts render useful text", () => {
    const text = mcp.renderPrompt("recall_recent_work", { minutes: "60" });
    assert.match(text, /ambient memory context/i);
  });
});
