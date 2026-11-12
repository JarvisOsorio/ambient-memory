import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("MemoryStore search + encryption", () => {
  let dataDir: string;
  let store: MemoryStore;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-store-"));
    store = new MemoryStore(
      buildConfig({
        dataDir,
        watchRoots: [dataDir],
        redactSecrets: true,
        forceFileKey: true,
      }),
    );
  });

  after(() => {
    store.close(false);
  });

  it("indexes entities and finds them by search", () => {
    store.upsertEntity({
      type: "file",
      title: "launch-plan.md",
      path: path.join(dataDir, "launch-plan.md"),
      body: "Ship ambient memory MVP for solo founders on GitHub",
      source: "test",
    });
    store.upsertEntity({
      type: "snippet",
      title: "mcp notes",
      body: "memory_search and memory_recent tools for Cursor",
      source: "test",
    });

    const hits = store.search("ambient founders");
    assert.ok(hits.length >= 1);
    assert.match(hits[0]!.entity.title, /launch-plan/);

    const mcp = store.search("memory_search Cursor");
    assert.ok(mcp.length >= 1);
  });

  it("redacts secrets before encrypting bodies", () => {
    const entity = store.upsertEntity({
      type: "snippet",
      title: "leaky notes",
      body: "deploy with sk-abcdefghijklmnopqrstuvwxyz123456 tonight",
      source: "test",
    })!;
    assert.match(entity.body ?? "", /REDACTED:openai_key/);
    assert.doesNotMatch(entity.body ?? "", /sk-abcdefgh/);
  });

  it("round-trips crypto through the store helper", () => {
    assert.equal(store.roundTrip("graph-node"), "graph-node");
  });

  it("creates relations and lists recent", () => {
    const a = store.upsertEntity({ type: "file", title: "a.ts", path: "/tmp/a.ts" })!;
    const b = store.upsertEntity({ type: "session", title: "Cursor: a.ts" })!;
    const link = store.relate(a.id, b.id, "opened_during");
    assert.equal(link.relation, "opened_during");
    const links = store.getLinks(a.id);
    assert.ok(links.some((l) => l.toId === b.id));
    const recent = store.recent(5);
    assert.ok(recent.length >= 2);
  });

  it("forgets matching entities", () => {
    store.upsertEntity({
      type: "file",
      title: "ephemeral-xyz.md",
      body: "ephemeral-xyz unique token",
      source: "test",
    });
    const before = store.search("ephemeral-xyz");
    assert.ok(before.length >= 1);
    const result = store.forget("ephemeral-xyz");
    assert.ok(result.deletedEntities >= 1);
    assert.equal(store.search("ephemeral-xyz").length, 0);
  });

  it("seals DB file on close(seal=true)", () => {
    const sealedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-seal-"));
    const cfg = buildConfig({ dataDir: sealedDir, forceFileKey: true });
    const s = new MemoryStore(cfg);
    s.upsertEntity({ type: "file", title: "sealed.txt", body: "secret-ish" });
    const dbPath = cfg.dbPath;
    s.close(true);
    assert.equal(fs.existsSync(dbPath), false);
    assert.equal(fs.existsSync(`${dbPath}.enc`), true);
    // reopen restores from envelope
    const s2 = new MemoryStore(cfg);
    const hits = s2.search("sealed");
    assert.ok(hits.length >= 1);
    s2.close(false);
  });
});
