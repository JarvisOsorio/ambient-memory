import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AmbientConfig } from "../config/defaults.js";
import { IpcClient } from "../ipc/client.js";
import { ipcEndpoint } from "../ipc/paths.js";
import { isProcessAlive, readPid } from "./pidfile.js";

export async function isDaemonReachable(config: AmbientConfig): Promise<boolean> {
  const client = await IpcClient.tryConnect(config, 400);
  if (!client) return false;
  try {
    await client.call("ping");
    client.close();
    return true;
  } catch {
    client.close();
    return false;
  }
}

/** Start detached daemon if needed and wait until IPC accepts connections. */
export async function ensureDaemonRunning(
  config: AmbientConfig,
  opts: { timeoutMs?: number; screen?: string } = {},
): Promise<{ started: boolean; pid: number | null }> {
  if (await isDaemonReachable(config)) {
    return { started: false, pid: readPid(config.pidPath) };
  }

  const existing = readPid(config.pidPath);
  if (existing && isProcessAlive(existing)) {
    // pid alive but socket not ready — wait briefly
    const ok = await waitForIpc(config, opts.timeoutMs ?? 5000);
    if (ok) return { started: false, pid: existing };
  }

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const selfEntry = process.argv[1] ?? path.join(process.cwd(), "bin", "ambient.js");
  const args = [
    selfEntry,
    "start",
    "--foreground",
    "--data-dir",
    config.dataDir,
    "--screen",
    opts.screen ?? config.screenProvider ?? "auto",
  ];
  if (config.forceFileKey) args.push("--file-key");
  if (config.dryRun) args.push("--dry-run");
  if (config.watchRoots?.length) {
    args.push("--roots", config.watchRoots.join(path.delimiter));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", fs.openSync(config.logPath, "a"), fs.openSync(config.logPath, "a")],
    env: process.env,
  });
  child.unref();

  const ok = await waitForIpc(config, opts.timeoutMs ?? 8000);
  if (!ok) {
    throw new Error(
      `Daemon failed to become ready at ${ipcEndpoint(config)} — see ${config.logPath}`,
    );
  }
  return { started: true, pid: readPid(config.pidPath) };
}

async function waitForIpc(config: AmbientConfig, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDaemonReachable(config)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function withDaemonClient<T>(
  config: AmbientConfig,
  fn: (client: IpcClient) => Promise<T>,
  opts: { autoStart?: boolean } = {},
): Promise<T> {
  const autoStart = opts.autoStart !== false;
  let client = await IpcClient.tryConnect(config, 500);
  if (!client && autoStart) {
    await ensureDaemonRunning(config);
    client = await IpcClient.connect(config, 3000);
  }
  if (!client) {
    throw new Error(
      `Ambient daemon is not running. Start it with: npx ambient-memory start\n(endpoint: ${ipcEndpoint(config)})`,
    );
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
