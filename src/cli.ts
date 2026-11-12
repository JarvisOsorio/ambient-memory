import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { APP_NAME, APP_VERSION, buildConfig, type AmbientConfig } from "./config/defaults.js";
import {
  AmbientDaemon,
  isProcessAlive,
  readPid,
  runDaemonForeground,
} from "./indexer/daemon.js";
import { probeScreen } from "./indexer/screen.js";
import { listRedactionKinds } from "./privacy/redact.js";
import { startMcpServer } from "./mcp/server.js";
import { MemoryStore } from "./store/memory-store.js";

function resolveConfig(opts: {
  dataDir?: string;
  roots?: string;
  exclude?: string;
  screen?: string;
  fileKey?: boolean;
  dryRun?: boolean;
}): AmbientConfig {
  return buildConfig({
    dataDir: opts.dataDir,
    watchRoots: opts.roots
      ? opts.roots.split(path.delimiter).filter(Boolean)
      : undefined,
    excludePaths: opts.exclude
      ? opts.exclude.split(path.delimiter).filter(Boolean)
      : undefined,
    screenProvider: (opts.screen as AmbientConfig["screenProvider"]) ?? "auto",
    forceFileKey: opts.fileKey === true || process.env.AMBIENT_FORCE_FILE_KEY === "1",
    dryRun: opts.dryRun === true,
  });
}

async function openStore(config: AmbientConfig): Promise<MemoryStore> {
  return MemoryStore.openAsync(config);
}

/** Seal when the daemon is not holding the plaintext DB open. */
function closeStore(store: MemoryStore, config: AmbientConfig): void {
  const daemonUp = isProcessAlive(readPid(config.pidPath));
  store.close(!daemonUp);
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("ambient")
    .description("Zero-config ambient memory — local daemon, CLI, and MCP server")
    .version(APP_VERSION);

  program
    .command("start")
    .description("Start the ambient indexer daemon")
    .option("--foreground", "Run in the current terminal", false)
    .option("--data-dir <path>", "Override data directory")
    .option("--roots <paths>", `Watch roots separated by '${path.delimiter}'`)
    .option("--exclude <paths>", `Exclude path prefixes separated by '${path.delimiter}'`)
    .option("--screen <mode>", "Screen provider: auto|simulated|none", "auto")
    .option("--file-key", "Force file-backed master key (skip OS keychain)", false)
    .option("--dry-run", "Observe without writing to the store", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const existing = readPid(config.pidPath);
      if (isProcessAlive(existing)) {
        console.log(`Already running (pid ${existing})`);
        return;
      }
      if (existing && fs.existsSync(config.pidPath)) {
        try {
          fs.unlinkSync(config.pidPath);
        } catch {
          /* ignore */
        }
      }

      if (opts.foreground) {
        console.log(`${APP_NAME} v${APP_VERSION} starting in foreground…`);
        console.log(`data: ${config.dataDir}${config.dryRun ? " (dry-run)" : ""}`);
        await runDaemonForeground(config);
        return;
      }

      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      const selfEntry = process.argv[1] ?? path.join(process.cwd(), "bin", "ambient.js");
      const child = spawn(
        process.execPath,
        [
          selfEntry,
          "start",
          "--foreground",
          ...(opts.dataDir ? ["--data-dir", opts.dataDir] : []),
          ...(opts.roots ? ["--roots", opts.roots] : []),
          ...(opts.exclude ? ["--exclude", opts.exclude] : []),
          ...(opts.screen ? ["--screen", opts.screen] : []),
          ...(opts.fileKey ? ["--file-key"] : []),
          ...(opts.dryRun ? ["--dry-run"] : []),
        ],
        {
          detached: true,
          stdio: [
            "ignore",
            fs.openSync(config.logPath, "a"),
            fs.openSync(config.logPath, "a"),
          ],
          env: process.env,
        },
      );
      child.unref();
      let pid: number | null = null;
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 100));
        pid = readPid(config.pidPath);
        if (pid && isProcessAlive(pid)) break;
      }
      if (!pid || !isProcessAlive(pid)) {
        console.error("Daemon failed to start — check logs:");
        console.error(`  ${config.logPath}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Started ambient daemon (pid ${pid})`);
      console.log(`Logs: ${config.logPath}`);
    });

  program
    .command("stop")
    .description("Stop the ambient indexer daemon")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const pid = readPid(config.pidPath);
      if (!pid || !isProcessAlive(pid)) {
        console.log("Daemon is not running");
        if (fs.existsSync(config.dbPath)) {
          const store = await openStore(config);
          store.close(true);
          console.log("Sealed encrypted store at rest");
        }
        try {
          if (fs.existsSync(config.pidPath)) fs.unlinkSync(config.pidPath);
        } catch {
          /* ignore */
        }
        return;
      }
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 30; i++) {
        if (!isProcessAlive(pid)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
        for (let i = 0; i < 20; i++) {
          if (!isProcessAlive(pid)) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        console.log(`Force-stopped ambient daemon (pid ${pid})`);
      } else {
        console.log(`Stopped ambient daemon (pid ${pid})`);
      }
      if (fs.existsSync(config.dbPath) && !isProcessAlive(pid)) {
        const store = await openStore(config);
        store.close(true);
        console.log("Sealed encrypted store at rest");
      }
      try {
        if (fs.existsSync(config.pidPath)) fs.unlinkSync(config.pidPath);
      } catch {
        /* ignore */
      }
    });

  program
    .command("status")
    .description("Show daemon and store health metrics")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const pid = readPid(config.pidPath);
      const running = isProcessAlive(pid);
      let storeStatus = null;
      let watchRoots = config.watchRoots;
      let screenProvider: string | undefined;
      if (fs.existsSync(config.dbPath) || fs.existsSync(`${config.dbPath}.enc`)) {
        const store = await openStore(config);
        storeStatus = store.status();
        const rootsRow = store.db.prepare(`SELECT value FROM meta WHERE key = 'watch_roots'`).get() as
          | { value: string }
          | undefined;
        if (rootsRow?.value) {
          try {
            watchRoots = JSON.parse(rootsRow.value) as string[];
          } catch {
            /* keep */
          }
        }
        const screenRow = store.db
          .prepare(`SELECT value FROM meta WHERE key = 'screen_provider'`)
          .get() as { value: string } | undefined;
        screenProvider = screenRow?.value;
        closeStore(store, config);
      }
      const screen = await probeScreen(
        (config.screenProvider as "auto" | "simulated" | "none") ?? "auto",
      );
      console.log(
        JSON.stringify(
          {
            app: APP_NAME,
            version: APP_VERSION,
            running,
            pid: running ? pid : null,
            dataDir: config.dataDir,
            watchRoots,
            screenProvider: screenProvider ?? screen.resolved,
            screenProbe: screen,
            store: storeStatus,
            sealedAtRest: !running && MemoryStore.isSealedAtRest(config.dbPath),
            privacy: {
              localOnly: true,
              telemetry: false,
              redactSecrets: true,
              encryptedAtRest: true,
              keyBackend: storeStatus?.keyBackend ?? null,
            },
          },
          null,
          2,
        ),
      );
    });

  program
    .command("search")
    .description("Search ambient memory (FTS5/BM25 + boosts)")
    .argument("<query>", "Search query")
    .option("--data-dir <path>", "Override data directory")
    .option("-n, --limit <n>", "Max results", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <types>", "Comma-separated types: file,session,snippet,url")
    .option("--path-prefix <prefix>", "Filter by path prefix")
    .option("--since-mins <n>", "Only last N minutes")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (query, opts) => {
      const config = resolveConfig(opts);
      const store = await openStore(config);
      const sinceMs = opts.sinceMins
        ? Date.now() - Number(opts.sinceMins) * 60_000
        : undefined;
      const hits = store.search(query, {
        limit: Number(opts.limit),
        offset: Number(opts.offset),
        types: opts.type ? opts.type.split(",") : undefined,
        pathPrefix: opts.pathPrefix,
        sinceMs,
      });
      if (hits.length === 0) {
        console.log("No matches.");
        closeStore(store, config);
        return;
      }
      for (const hit of hits) {
        console.log(
          `[${hit.score.toFixed(2)}] ${hit.entity.type}  ${hit.entity.title}${
            hit.entity.path ? `  (${hit.entity.path})` : ""
          }`,
        );
      }
      closeStore(store, config);
    });

  program
    .command("recent")
    .description("Show recently seen entities")
    .option("--data-dir <path>", "Override data directory")
    .option("-n, --limit <n>", "Max results", "10")
    .option("--type <types>", "Comma-separated types")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const store = await openStore(config);
      const entities = store.recent(Number(opts.limit), {
        types: opts.type ? opts.type.split(",") : undefined,
      });
      for (const e of entities) {
        const when = new Date(e.lastSeenAt).toISOString();
        console.log(`${when}  ${e.type.padEnd(8)}  ${e.title}`);
      }
      if (entities.length === 0) console.log("No entities yet. Start the daemon or run the demo.");
      closeStore(store, config);
    });

  program
    .command("context")
    .description("Narrative summary of what you were doing")
    .option("--minutes <n>", "Lookback window", "30")
    .option("--data-dir <path>", "Override data directory")
    .option("--json", "Print full JSON", false)
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const store = await openStore(config);
      const ctx = store.buildContext(Number(opts.minutes));
      if (opts.json) {
        console.log(JSON.stringify(ctx, null, 2));
      } else {
        console.log(ctx.narrative);
        if (ctx.files.length) {
          console.log("\nFiles:");
          for (const f of ctx.files.slice(0, 8)) console.log(`  - ${f.title}`);
        }
        if (ctx.sessions.length) {
          console.log("\nSessions:");
          for (const s of ctx.sessions.slice(0, 5)) console.log(`  - ${s.title}`);
        }
      }
      closeStore(store, config);
    });

  program
    .command("forget")
    .description("Purge memory matching a query, or all with --all")
    .argument("[query]", "Query to forget")
    .option("--all", "Delete everything", false)
    .option("--data-dir <path>", "Override data directory")
    .option("--yes", "Skip confirmation", false)
    .option("--file-key", "Force file-backed master key", false)
    .action(async (query, opts) => {
      if (!opts.all && !query) {
        console.error("Provide a query or --all");
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        console.error("Refusing to purge without --yes");
        process.exitCode = 1;
        return;
      }
      const config = resolveConfig(opts);
      const store = await openStore(config);
      const result = store.forget(opts.all ? "*" : query);
      console.log(
        `Forgot ${result.deletedEntities} entities and ${result.deletedEvents} events`,
      );
      closeStore(store, config);
    });

  program
    .command("mcp")
    .description("Run the MCP server on stdio (for Cursor / Claude Desktop)")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      await startMcpServer(config);
    });

  program
    .command("init")
    .description("Create data dir + key with zero-config defaults (idempotent)")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const store = await openStore(config);
      const status = store.status();
      closeStore(store, config);
      const screen = await probeScreen("auto");
      console.log(
        JSON.stringify(
          {
            ok: true,
            message: "Ambient memory ready — no questions asked",
            version: APP_VERSION,
            dataDir: config.dataDir,
            watchRoots: config.watchRoots,
            store: status,
            screenProbe: { resolved: screen.resolved, note: screen.note },
            key: { backend: status.keyBackend, detail: status.keyDetail },
          },
          null,
          2,
        ),
      );
    });

  program
    .command("doctor")
    .description("Diagnose screen/browser/key/store health on this machine")
    .option("--data-dir <path>", "Override data directory")
    .option("--screen <mode>", "Screen preference", "auto")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const screen = await probeScreen(opts.screen ?? "auto");
      const { readRecentBrowserHistory } = await import("./indexer/browser.js");
      const browser = readRecentBrowserHistory();
      let key = null;
      let storeHealth = null;
      const issues: string[] = [];
      const notes: string[] = [];
      try {
        const store = await openStore({ ...config, forceFileKey: config.forceFileKey });
        key = { backend: store.crypto.keyBackend, detail: store.crypto.keyDetail };
        storeHealth = store.status();
        if (!storeHealth.integrityOk) issues.push("Store integrity HMAC mismatch");
        closeStore(store, config);
      } catch (err) {
        key = { error: err instanceof Error ? err.message : String(err) };
        issues.push("Failed to open store/key");
      }
      if (screen.resolved === "none") {
        notes.push("No screen provider — use --screen simulated on headless hosts");
      } else if (!screen.sample) {
        notes.push(
          `Screen provider "${screen.resolved}" selected but capture returned null (permissions / no focused window)`,
        );
      }
      if (browser.result.indexed === 0 && browser.result.skippedReason) {
        notes.push(`Browser optional: ${browser.result.skippedReason}`);
      }
      const pid = readPid(config.pidPath);
      if (pid && !isProcessAlive(pid)) issues.push("Stale pidfile present (safe to delete via ambient stop)");
      if (
        !isProcessAlive(pid) &&
        fs.existsSync(config.dbPath) &&
        fs.existsSync(`${config.dbPath}.enc`)
      ) {
        issues.push("Plaintext memory.db present beside .enc while daemon is stopped — run ambient stop to re-seal");
      }
      console.log(
        JSON.stringify(
          {
            ok: issues.length === 0,
            version: APP_VERSION,
            platform: process.platform,
            node: process.version,
            screen,
            browser: browser.result,
            key,
            store: storeHealth,
            sealedAtRest: MemoryStore.isSealedAtRest(config.dbPath),
            redactionKinds: listRedactionKinds().length,
            telemetry: false,
            issues,
            notes,
          },
          null,
          2,
        ),
      );
    });

  await program.parseAsync(argv);
}
