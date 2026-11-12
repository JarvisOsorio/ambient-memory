import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EnvelopeCrypto } from "../../src/crypto/envelope.js";

describe("EnvelopeCrypto", () => {
  it("round-trips string encryption", () => {
    const c = new EnvelopeCrypto(EnvelopeCrypto.generateKey());
    const plain = "hello ambient memory 🔐";
    const enc = c.encrypt(plain);
    assert.notEqual(enc, plain);
    assert.equal(c.decrypt(enc), plain);
  });

  it("loads or creates a key file with restrictive perms", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-key-"));
    const keyPath = path.join(dir, "master.key");
    const a = EnvelopeCrypto.loadOrCreateKey(keyPath);
    const b = EnvelopeCrypto.loadOrCreateKey(keyPath);
    assert.equal(a.encrypt("x").length > 0, true);
    // same key decrypts
    const payload = a.encrypt("same-key");
    assert.equal(b.decrypt(payload), "same-key");
    const mode = fs.statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("encrypts and decrypts files at rest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-file-"));
    const c = new EnvelopeCrypto(EnvelopeCrypto.generateKey());
    const src = path.join(dir, "memory.db");
    const enc = path.join(dir, "memory.db.enc");
    const out = path.join(dir, "memory-out.db");
    fs.writeFileSync(src, "sqlite-bytes-not-really");
    c.encryptFile(src, enc, true);
    assert.equal(fs.existsSync(src), false);
    c.decryptFile(enc, out);
    assert.equal(fs.readFileSync(out, "utf8"), "sqlite-bytes-not-really");
  });
});
