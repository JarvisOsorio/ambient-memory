import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("stress ingest + incremental", () => {
  let store: MemoryStore;
  let dataDir: string;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-stress-"));
    store = new MemoryStore(buildConfig({ dataDir, forceFileKey: true }));
  });

  after(() => store.close(false));

  it("indexes 200 entities quickly and searches under budget", () => {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      store.upsertEntity({
        type: "file",
        title: `module-${i}.ts`,
        path: `/stress/src/module-${i}.ts`,
        body: `export const value${i} = ${i}; // ambient stress token-${i % 17}`,
        source: "stress",
        skipIfUnchanged: true,
      });
    }
    const ingestMs = Date.now() - t0;
    assert.ok(ingestMs < 5000, `ingest too slow: ${ingestMs}ms`);

    const t1 = Date.now();
    const hits = store.search("token-3 module", { limit: 10 });
    const searchMs = Date.now() - t1;
    assert.ok(hits.length >= 1);
    assert.ok(searchMs < 200, `search too slow: ${searchMs}ms`);

    const status = store.status();
    assert.ok(status.entities >= 200);
    assert.equal(status.integrityOk, true);
    assert.equal(status.fts, true);
  });

  it("skipIfUnchanged avoids rewrite on same hash", () => {
    const first = store.upsertEntity({
      type: "file",
      title: "stable.ts",
      path: "/stress/stable.ts",
      body: "unchanging",
      skipIfUnchanged: true,
    })!;
    const updatedAt = first.updatedAt;
    const second = store.upsertEntity({
      type: "file",
      title: "stable.ts",
      path: "/stress/stable.ts",
      body: "unchanging",
      skipIfUnchanged: true,
    })!;
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.updatedAt, updatedAt);
  });
});
