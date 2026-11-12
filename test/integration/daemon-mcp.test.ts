import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { AmbientDaemon } from "../../src/indexer/daemon.js";
import { createMcpHandlers } from "../../src/mcp/server.js";
import { MCP_TOOLS } from "../../src/mcp/tools.js";

describe("daemon + MCP handlers", () => {
  let dataDir: string;
  let fixtureRoot: string;
  let daemon: AmbientDaemon;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-daemon-"));
    fixtureRoot = path.join(dataDir, "workspace");
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, "notes-on-mars.md"),
      "# Mars clout\nWorking on Get clout on Github ambient memory.\n",
    );

    const config = buildConfig({
      dataDir,
      watchRoots: [fixtureRoot],
      screenProvider: "simulated",
      screenIntervalMs: 50,
      browserEnabled: true,
      redactSecrets: true,
      forceFileKey: true,
    });
    daemon = new AmbientDaemon(config);
    await daemon.start();
    // allow watcher + screen tick
    await new Promise((r) => setTimeout(r, 600));
  });

  after(async () => {
    await daemon.stop(false);
  });

  it("indexes fixture files from the watcher", () => {
    const hits = daemon.store.search("mars clout");
    assert.ok(hits.length >= 1, "expected fixture file in search results");
    assert.match(hits[0]!.entity.title, /notes-on-mars/);
  });

  it("captures simulated screen sessions", () => {
    const sessions = daemon.store.recent(50).filter((e) => e.type === "session");
    assert.ok(sessions.length >= 1, "expected at least one screen session");
    const status = daemon.getStatus();
    assert.equal(status.screenProvider, "simulated");
    assert.equal(status.running, true);
  });

  it("exposes MCP tools that search/recent/relate/status", () => {
    const mcp = createMcpHandlers(daemon.store);
    assert.ok(mcp.listTools().length >= 6);
    assert.equal(mcp.listTools().length, MCP_TOOLS.length);

    const search = mcp.callTool("memory_search", { query: "ambient memory", limit: 5 });
    assert.equal(search.isError, undefined);
    const searchPayload = JSON.parse(search.content[0]!.text) as { count: number; ok?: boolean };
    assert.ok(searchPayload.count >= 1);

    const recent = mcp.callTool("memory_recent", { limit: 5 });
    const recentPayload = JSON.parse(recent.content[0]!.text) as {
      entities: unknown[];
    };
    assert.ok(recentPayload.entities.length >= 1);

    const a = daemon.store.recent(1)[0]!;
    const b =
      daemon.store.recent(2)[1] ??
      daemon.store.upsertEntity({ type: "snippet", title: "link-target" });
    const relate = mcp.callTool("memory_relate", {
      fromId: a.id,
      toId: b.id,
      relation: "related_to",
    });
    assert.equal(relate.isError, undefined);

    const status = mcp.callTool("memory_status", {});
    const statusPayload = JSON.parse(status.content[0]!.text) as {
      store: { entities: number };
      privacy: { localOnly: boolean };
    };
    assert.ok(statusPayload.store.entities >= 1);
    assert.equal(statusPayload.privacy.localOnly, true);
  });

  it("skips browser hook cleanly when no history exists", () => {
    const note = daemon.browserNote;
    assert.ok(note);
    // On a fresh VM, typically skipped — either way must not throw and should be structured
    assert.equal(typeof note.indexed, "number");
  });
});
