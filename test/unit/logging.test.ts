import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { RotatingLogger } from "../../src/indexer/logging.js";

describe("RotatingLogger", () => {
  it("rotates when maxBytes exceeded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-log-"));
    const logPath = path.join(dir, "daemon.log");
    const logger = new RotatingLogger({ logPath, maxBytes: 64, backups: 2 });
    for (let i = 0; i < 20; i++) {
      logger.info(`line-${i}-xxxxxxxxxxxxxxxxxxxxxxxx`);
    }
    assert.equal(fs.existsSync(logPath), true);
    assert.equal(fs.existsSync(`${logPath}.1`), true);
  });
});
