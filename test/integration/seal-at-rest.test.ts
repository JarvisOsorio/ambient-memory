import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("seal at rest", () => {
  it("close(true) leaves only .enc — no plaintext db/wal/shm", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-seal2-"));
    const cfg = buildConfig({ dataDir, forceFileKey: true });
    const store = new MemoryStore(cfg);
    store.upsertEntity({
      type: "file",
      title: "a.md",
      body: "secret-ish content",
      path: path.join(dataDir, "a.md"),
    });
    store.close(true);
    assert.equal(fs.existsSync(cfg.dbPath), false, "plaintext db must be gone");
    assert.equal(fs.existsSync(`${cfg.dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${cfg.dbPath}-shm`), false);
    assert.equal(fs.existsSync(`${cfg.dbPath}.enc`), true);
    assert.equal(MemoryStore.isSealedAtRest(cfg.dbPath), true);

    // Re-open from seal, query, re-seal — no leftover plaintext
    const store2 = new MemoryStore(cfg);
    assert.equal(store2.restoredFromSeal, true);
    assert.ok(store2.search("secret-ish").length >= 1);
    store2.close(true);
    assert.equal(MemoryStore.isSealedAtRest(cfg.dbPath), true);
    assert.equal(fs.existsSync(cfg.dbPath), false);
  });
});
