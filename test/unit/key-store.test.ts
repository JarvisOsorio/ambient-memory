import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadOrCreateMasterKey, readKeyBackendMeta } from "../../src/crypto/key-store.js";
import { EnvelopeCrypto } from "../../src/crypto/envelope.js";

describe("key-store file fallback", () => {
  it("creates a 0600 file key when keychain is forced off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-keystore-"));
    const keyPath = path.join(dir, "master.key");
    const a = await loadOrCreateMasterKey({ keyPath, forceFile: true });
    assert.equal(a.backend, "file");
    assert.equal(a.key.length, 32);
    const mode = fs.statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const meta = readKeyBackendMeta(keyPath);
    assert.equal(meta?.backend, "file");

    const b = await loadOrCreateMasterKey({ keyPath, forceFile: true });
    assert.deepEqual(Buffer.from(b.key), Buffer.from(a.key));
  });

  it("EnvelopeCrypto.loadOrCreateAsync forceFile works", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-env-"));
    const keyPath = path.join(dir, "master.key");
    const c = await EnvelopeCrypto.loadOrCreateAsync(keyPath, { forceFile: true });
    assert.equal(c.keyBackend, "file");
    assert.equal(c.decrypt(c.encrypt("hello")), "hello");
  });
});
