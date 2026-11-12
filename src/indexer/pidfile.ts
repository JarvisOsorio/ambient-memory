import fs from "node:fs";
import path from "node:path";

export function readPid(pidPath: string): number | null {
  try {
    if (!fs.existsSync(pidPath)) return null;
    const n = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type PidAcquireResult =
  | { ok: true; pid: number; recoveredStale?: boolean }
  | { ok: false; reason: "already_running"; pid: number };

/**
 * Atomically acquire a pidfile (wx). Clears stale pidfiles from dead processes.
 * Mitigates two-process race on start.
 */
export function acquirePidFile(pidPath: string, pid = process.pid): PidAcquireResult {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true, mode: 0o700 });

  let recoveredStale = false;
  const existing = readPid(pidPath);
  if (existing) {
    if (isProcessAlive(existing)) {
      return { ok: false, reason: "already_running", pid: existing };
    }
    try {
      fs.unlinkSync(pidPath);
      recoveredStale = true;
    } catch {
      /* continue to wx attempt */
    }
  }

  try {
    fs.writeFileSync(pidPath, `${pid}\n`, { flag: "wx", mode: 0o600 });
    return { ok: true, pid, recoveredStale };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const other = readPid(pidPath);
      if (other && isProcessAlive(other)) {
        return { ok: false, reason: "already_running", pid: other };
      }
      // Stale raced in — retry once
      try {
        fs.unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
      try {
        fs.writeFileSync(pidPath, `${pid}\n`, { flag: "wx", mode: 0o600 });
        return { ok: true, pid, recoveredStale: true };
      } catch {
        const again = readPid(pidPath);
        if (again && isProcessAlive(again)) {
          return { ok: false, reason: "already_running", pid: again };
        }
        throw err;
      }
    }
    throw err;
  }
}

export function releasePidFile(pidPath: string, expectedPid = process.pid): void {
  try {
    const current = readPid(pidPath);
    if (current === expectedPid || current === null) {
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
    }
  } catch {
    /* ignore */
  }
}
