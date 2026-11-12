import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import { AmbientDaemon } from "../../src/indexer/daemon.js";
import { IpcClient } from "../../src/ipc/client.js";
import { MemoryStore } from "../../src/store/memory-store.js";

describe("daemon IPC ownership", () => {
  let dataDir: string;
  let daemon: AmbientDaemon;
  let config: ReturnType<typeof buildConfig>;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-ipc-"));
    config = buildConfig({
      dataDir,
      watchRoots: [path.join(dataDir, "ws")],
      screenProvider: "none",
      browserEnabled: false,
      forceFileKey: true,
      screenIntervalMs: 60_000,
    });
    fs.mkdirSync(config.watchRoots[0]!, { recursive: true });
    daemon = new AmbientDaemon(config);
    await daemon.start();
    daemon.store.upsertEntity({
      type: "file",
      title: "ipc-probe.md",
      body: "daemon owned sqlite ipc probe",
      path: path.join(dataDir, "ipc-probe.md"),
    });
  });

  after(async () => {
    await daemon.stop(true);
    assert.equal(MemoryStore.isSealedAtRest(config.dbPath), true);
  });

  it("serves search/context/status over the unix socket without a second DB open", async () => {
    const client = await IpcClient.connect(config, 2000);
    try {
      const pong = await client.call<{ pong: boolean }>("ping");
      assert.equal(pong.pong, true);

      const hits = await client.call<Array<{ entity: { title: string } }>>("search", {
        query: "ipc probe",
        limit: 5,
      });
      assert.ok(hits.length >= 1);
      assert.match(hits[0]!.entity.title, /ipc-probe/);

      const status = await client.call<{ store: { entities: number; sqliteBackend: string } }>(
        "status",
      );
      assert.ok(status.store.entities >= 1);
      assert.ok(["node-sqlite", "sql.js"].includes(status.store.sqliteBackend));

      const ctx = await client.call<{ narrative: string; noise: { droppedSessions: number } }>(
        "context",
        { minutes: 30 },
      );
      assert.ok(typeof ctx.narrative === "string");
      assert.ok(ctx.noise);
    } finally {
      client.close();
    }
  });
});
