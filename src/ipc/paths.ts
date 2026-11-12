import crypto from "node:crypto";
import path from "node:path";
import type { AmbientConfig } from "../config/defaults.js";

/** Unix domain socket path, or Windows named pipe path. */
export function ipcEndpoint(config: AmbientConfig): string {
  if (config.socketPath) return config.socketPath;
  if (process.platform === "win32") {
    const hash = crypto.createHash("sha256").update(config.dataDir).digest("hex").slice(0, 16);
    return `\\.\pipe\ambient-memory-${hash}`;
  }
  return path.join(config.dataDir, "ambient.sock");
}
