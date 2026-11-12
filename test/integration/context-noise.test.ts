import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("context noise reduction", () => {
  it("memory_context drops Slack/Spotify and collapses Cursor churn", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-noise-ctx-"));
    const cfg = buildConfig({ dataDir, forceFileKey: true });
    const store = new MemoryStore(cfg);
    const now = Date.now();

    store.upsertEntity({
      type: "session",
      title: "Slack: #random",
      source: "screen",
      metadata: { appName: "Slack" },
      seenAt: now,
    });
    store.upsertEntity({
      type: "session",
      title: "Spotify: Discover Weekly",
      source: "screen",
      metadata: { appName: "Spotify" },
      seenAt: now - 1000,
    });
    store.upsertEntity({
      type: "session",
      title: "Cursor: src/cli.ts",
      source: "screen",
      metadata: { appName: "Cursor" },
      seenAt: now - 2000,
    });
    store.upsertEntity({
      type: "session",
      title: "Cursor: src/store/search.ts",
      source: "screen",
      metadata: { appName: "Cursor" },
      seenAt: now - 3000,
    });
    store.upsertEntity({
      type: "file",
      title: "search.ts",
      body: "fts or query",
      path: path.join(dataDir, "search.ts"),
      seenAt: now - 2500,
    });

    const ctx = store.buildContext(60);
    assert.ok(!ctx.sessions.some((s) => /slack|spotify/i.test(s.title)));
    assert.ok(ctx.sessions.some((s) => /Cursor/i.test(s.title)));
    assert.ok(ctx.noise.droppedSessions >= 2);
    assert.ok(ctx.noise.collapsedSessions >= 1);
    assert.match(ctx.narrative, /Noise control/i);
    assert.ok(ctx.files.some((f) => f.title === "search.ts"));
    store.close(true);
  });
});
