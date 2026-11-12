import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadOrCreateMasterKey, type KeyBackend } from "./key-store.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGO = "aes-256-gcm";

export class EnvelopeCrypto {
  private readonly key: Buffer;
  readonly keyBackend: KeyBackend;
  readonly keyDetail: string;

  constructor(key: Buffer, meta?: { backend: KeyBackend; detail: string }) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
    }
    this.key = key;
    this.keyBackend = meta?.backend ?? "file";
    this.keyDetail = meta?.detail ?? "inline";
  }

  static generateKey(): Buffer {
    return crypto.randomBytes(KEY_BYTES);
  }

  /** Sync file-only loader (tests / forced file). Prefer loadOrCreateAsync for production. */
  static loadOrCreateKey(keyPath: string): EnvelopeCrypto {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(keyPath)) {
      const key = EnvelopeCrypto.generateKey();
      const tmp = `${keyPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, key, { mode: 0o600 });
      fs.renameSync(tmp, keyPath);
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        /* ignore */
      }
      return new EnvelopeCrypto(key, { backend: "file", detail: `file:${keyPath}` });
    }
    const key = fs.readFileSync(keyPath);
    return new EnvelopeCrypto(key, { backend: "file", detail: `file:${keyPath}` });
  }

  static async loadOrCreateAsync(
    keyPath: string,
    options?: { preferKeychain?: boolean; forceFile?: boolean },
  ): Promise<EnvelopeCrypto> {
    const result = await loadOrCreateMasterKey({
      keyPath,
      preferKeychain: options?.preferKeychain,
      forceFile: options?.forceFile,
    });
    return new EnvelopeCrypto(result.key, {
      backend: result.backend,
      detail: result.detail,
    });
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  decrypt(payload: string): string {
    const buf = Buffer.from(payload, "base64");
    if (buf.length < IV_BYTES + 16) {
      throw new Error("Invalid ciphertext");
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + 16);
    const data = buf.subarray(IV_BYTES + 16);
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  encryptFile(srcPath: string, destPath: string, removePlain = false): void {
    const plaintext = fs.readFileSync(srcPath);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(destPath, Buffer.concat([iv, tag, enc]), { mode: 0o600 });
    if (removePlain) fs.unlinkSync(srcPath);
  }

  decryptFile(srcPath: string, destPath: string): void {
    const buf = fs.readFileSync(srcPath);
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + 16);
    const data = buf.subarray(IV_BYTES + 16);
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destPath, plain, { mode: 0o600 });
  }

  /** HMAC-SHA256 over payload using the master key (integrity, not encryption). */
  hmac(payload: string): string {
    return crypto.createHmac("sha256", this.key).update(payload).digest("hex");
  }
}
