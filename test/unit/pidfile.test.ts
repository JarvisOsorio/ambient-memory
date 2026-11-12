import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { acquirePidFile, readPid, releasePidFile } from "../../src/indexer/pidfile.js";

describe("pidfile", () => {
  it("acquires atomically and rejects second live owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-pid-"));
    const pidPath = path.join(dir, "daemon.pid");
    const first = acquirePidFile(pidPath, process.pid);
    assert.equal(first.ok, true);
    assert.equal(readPid(pidPath), process.pid);

    const second = acquirePidFile(pidPath, process.pid + 99999);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "already_running");

    releasePidFile(pidPath, process.pid);
    assert.equal(readPid(pidPath), null);

    const third = acquirePidFile(pidPath, process.pid);
    assert.equal(third.ok, true);
    releasePidFile(pidPath, process.pid);
  });

  it("recovers stale pidfile from a dead pid", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-pid-stale-"));
    const pidPath = path.join(dir, "daemon.pid");
    // PID 1 may be alive on Linux — use an absurd pid unlikely to exist
    const deadPid = 2147483646;
    fs.writeFileSync(pidPath, `${deadPid}\n`);
    const result = acquirePidFile(pidPath, process.pid);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.recoveredStale, true);
    releasePidFile(pidPath, process.pid);
  });
});
