import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { APP_NAME } from "../config/defaults.js";

const execFileAsync = promisify(execFile);
const KEY_BYTES = 32;
const ACCOUNT = "master-key";
const SERVICE = APP_NAME;

export type KeyBackend = "keychain" | "file";

export interface KeyLoadResult {
  key: Buffer;
  backend: KeyBackend;
  detail: string;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/** macOS Keychain via `security`. */
async function macKeychainGet(): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      { timeout: 5000 },
    );
    const hex = stdout.trim();
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === KEY_BYTES * 2) {
      return Buffer.from(hex, "hex");
    }
    // Older / alternate storage as base64
    const buf = Buffer.from(hex, "base64");
    if (buf.length === KEY_BYTES) return buf;
    return null;
  } catch {
    return null;
  }
}

async function macKeychainSet(key: Buffer): Promise<boolean> {
  const hex = key.toString("hex");
  try {
    // delete existing quietly
    await execFileAsync(
      "security",
      ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT],
      { timeout: 5000 },
    ).catch(() => undefined);
    await execFileAsync(
      "security",
      [
        "add-generic-password",
        "-s",
        SERVICE,
        "-a",
        ACCOUNT,
        "-w",
        hex,
        "-T",
        "",
        "-U",
      ],
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Linux Secret Service via `secret-tool` (libsecret). */
async function linuxSecretGet(): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      "secret-tool",
      ["lookup", "service", SERVICE, "account", ACCOUNT],
      { timeout: 5000 },
    );
    const hex = stdout.trim();
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === KEY_BYTES * 2) {
      return Buffer.from(hex, "hex");
    }
    return null;
  } catch {
    return null;
  }
}

async function linuxSecretSet(key: Buffer): Promise<boolean> {
  try {
    const { spawn } = await import("node:child_process");
    const hex = key.toString("hex");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "secret-tool",
        ["store", "--label", `${SERVICE} master key`, "service", SERVICE, "account", ACCOUNT],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      child.stdin.write(hex);
      child.stdin.end();
    });
    return true;
  } catch {
    return false;
  }
}

/** Windows Credential Manager via PowerShell (best-effort). */
async function windowsCredGet(): Promise<Buffer | null> {
  if (process.platform !== "win32") return null;
  const script = `
    $c = Get-StoredCredential -Target '${SERVICE}/${ACCOUNT}' -ErrorAction SilentlyContinue
    if (-not $c) { exit 2 }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($c.Password)
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    Write-Output $plain
  `;
  // CredentialManager module may be missing — try cmdkey/generic fallback path via pure file.
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout: 8000 },
    );
    const hex = stdout.trim();
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === KEY_BYTES * 2) {
      return Buffer.from(hex, "hex");
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function windowsCredSet(key: Buffer): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const hex = key.toString("hex");
  // Prefer file on Windows unless CredentialManager is clearly available —
  // many CI/desktop images lack the module. Documented as optional.
  try {
    const script = `
      if (-not (Get-Module -ListAvailable -Name CredentialManager)) { exit 3 }
      New-StoredCredential -Target '${SERVICE}/${ACCOUNT}' -UserName '${ACCOUNT}' -Password '${hex}' -Persist LocalMachine | Out-Null
    `;
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function readFileKey(keyPath: string): Buffer | null {
  try {
    if (!fs.existsSync(keyPath)) return null;
    const key = fs.readFileSync(keyPath);
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function writeFileKey(keyPath: string, key: Buffer): void {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const tmp = `${keyPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.renameSync(tmp, keyPath);
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* windows */
  }
}

export interface LoadKeyOptions {
  keyPath: string;
  /** Prefer OS keychain when available (default true). */
  preferKeychain?: boolean;
  /** Force file backend (tests). */
  forceFile?: boolean;
}

/**
 * Load or create the master key.
 * Prefers OS keychain (macOS Keychain, Linux secret-tool, Windows CredentialManager when present).
 * Falls back to a mode-0600 file at keyPath and records backend in sibling meta file.
 */
export async function loadOrCreateMasterKey(options: LoadKeyOptions): Promise<KeyLoadResult> {
  const preferKeychain = options.preferKeychain !== false && !options.forceFile;
  const metaPath = `${options.keyPath}.backend`;

  // 1) Existing file key always wins for continuity (migrate optionally later)
  const existingFile = readFileKey(options.keyPath);
  if (existingFile && options.forceFile) {
    return {
      key: existingFile,
      backend: "file",
      detail: `file:${options.keyPath}`,
    };
  }

  if (preferKeychain) {
    if (process.platform === "darwin" && (await commandExists("security"))) {
      const fromKc = await macKeychainGet();
      if (fromKc) {
        writeBackendMeta(metaPath, "keychain", "macos-security");
        return { key: fromKc, backend: "keychain", detail: "macos-keychain" };
      }
      // migrate file → keychain if present
      if (existingFile && (await macKeychainSet(existingFile))) {
        writeBackendMeta(metaPath, "keychain", "macos-security-migrated");
        return { key: existingFile, backend: "keychain", detail: "macos-keychain-migrated" };
      }
      const fresh = crypto.randomBytes(KEY_BYTES);
      if (await macKeychainSet(fresh)) {
        writeBackendMeta(metaPath, "keychain", "macos-security");
        return { key: fresh, backend: "keychain", detail: "macos-keychain-created" };
      }
    }

    if (process.platform === "linux" && (await commandExists("secret-tool"))) {
      const fromSec = await linuxSecretGet();
      if (fromSec) {
        writeBackendMeta(metaPath, "keychain", "linux-secret-tool");
        return { key: fromSec, backend: "keychain", detail: "linux-libsecret" };
      }
      if (existingFile && (await linuxSecretSet(existingFile))) {
        writeBackendMeta(metaPath, "keychain", "linux-secret-tool-migrated");
        return { key: existingFile, backend: "keychain", detail: "linux-libsecret-migrated" };
      }
      const fresh = crypto.randomBytes(KEY_BYTES);
      if (await linuxSecretSet(fresh)) {
        writeBackendMeta(metaPath, "keychain", "linux-secret-tool");
        return { key: fresh, backend: "keychain", detail: "linux-libsecret-created" };
      }
    }

    if (process.platform === "win32") {
      const fromWin = await windowsCredGet();
      if (fromWin) {
        writeBackendMeta(metaPath, "keychain", "windows-credential-manager");
        return { key: fromWin, backend: "keychain", detail: "windows-credman" };
      }
      const fresh = crypto.randomBytes(KEY_BYTES);
      if (await windowsCredSet(fresh)) {
        writeBackendMeta(metaPath, "keychain", "windows-credential-manager");
        return { key: fresh, backend: "keychain", detail: "windows-credman-created" };
      }
    }
  }

  // File fallback (documented secure default for headless / CI / no keychain)
  if (existingFile) {
    writeBackendMeta(metaPath, "file", options.keyPath);
    return { key: existingFile, backend: "file", detail: `file:${options.keyPath}` };
  }
  const key = crypto.randomBytes(KEY_BYTES);
  writeFileKey(options.keyPath, key);
  writeBackendMeta(metaPath, "file", options.keyPath);
  return {
    key,
    backend: "file",
    detail: `file-fallback:${options.keyPath} (mode 0600; dir ${path.dirname(options.keyPath)} mode 0700)`,
  };
}

function writeBackendMeta(metaPath: string, backend: KeyBackend, detail: string): void {
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        { backend, detail, host: os.hostname(), updatedAt: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    /* ignore */
  }
}

export function readKeyBackendMeta(
  keyPath: string,
): { backend: KeyBackend; detail: string } | null {
  try {
    const raw = fs.readFileSync(`${keyPath}.backend`, "utf8");
    const parsed = JSON.parse(raw) as { backend: KeyBackend; detail: string };
    return parsed;
  } catch {
    return null;
  }
}
