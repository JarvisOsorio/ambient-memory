import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { APP_NAME, APP_VERSION, buildConfig, type AmbientConfig } from "./config/defaults.js";
import { ensureDaemonRunning, withDaemonClient } from "./indexer/ensure-daemon.js";
import {
  isProcessAlive,
  readPid,
  runDaemonForeground,
} from "./indexer/daemon.js";
import { probeScreen } from "./indexer/screen.js";
import { listRedactionKinds } from "./privacy/redact.js";
import { startMcpServer } from "./mcp/server.js";
import { MemoryStore } from "./store/memory-store.js";
import { detectSqliteBackend } from "./store/sqlite.js";
import { ipcEndpoint } from "./ipc/paths.js";
import type { ContextSummary, MemoryEntity, SearchHit } from "./store/memory-store.js";

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

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("ambient")
    .description(
      "Zero-config ambient memory — daemon owns the vault; CLI/MCP are thin IPC clients",
    )
    .version(APP_VERSION);

  program
    .command("start")
    .description("Start the ambient indexer daemon (sole process that opens SQLite)")
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
        console.log(`IPC: ${ipcEndpoint(config)}`);
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
        console.log(`sqlite: ${detectSqliteBackend()}`);
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

      try {
        await ensureDaemonRunning(config, { timeoutMs: 8000, screen: opts.screen });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
        return;
      }
      const pid = readPid(config.pidPath);
      console.log(`Started ambient daemon (pid ${pid})`);
      console.log(`IPC: ${ipcEndpoint(config)}`);
      console.log(`Logs: ${config.logPath}`);
    });

  program
    .command("stop")
    .description("Stop the ambient indexer daemon (daemon seals the vault)")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const pid = readPid(config.pidPath);
      if (!pid || !isProcessAlive(pid)) {
        console.log("Daemon is not running");
        // Best-effort seal if plaintext leaked from a crash
        if (fs.existsSync(config.dbPath)) {
          const store = await MemoryStore.openAsync(config);
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
      for (let i = 0; i < 40; i++) {
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
        const store = await MemoryStore.openAsync(config);
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
    .description("Show daemon and store health metrics (via IPC when daemon is up)")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const pid = readPid(config.pidPath);
      const running = isProcessAlive(pid);
      const screen = await probeScreen(
        (config.screenProvider as "auto" | "simulated" | "none") ?? "auto",
      );
      let payload: Record<string, unknown> = {
        app: APP_NAME,
        version: APP_VERSION,
        running,
        pid: running ? pid : null,
        dataDir: config.dataDir,
        ipcEndpoint: ipcEndpoint(config),
        sqliteBackendPreferred: detectSqliteBackend(),
        screenProbe: screen,
        sealedAtRest: !running && MemoryStore.isSealedAtRest(config.dbPath),
        privacy: {
          localOnly: true,
          telemetry: false,
          redactSecrets: true,
          fieldEncryption: true,
          ftsPlaintextWhileUnlocked: true,
          sealedEnvelopeAtRest: true,
        },
      };
      if (running) {
        try {
          const remote = await withDaemonClient(config, (c) => c.call("status"), {
            autoStart: false,
          });
          payload = { ...payload, ...(remote as object), via: "ipc" };
        } catch (err) {
          payload.ipcError = err instanceof Error ? err.message : String(err);
        }
      }
      console.log(JSON.stringify(payload, null, 2));
    });

  program
    .command("search")
    .description("Search ambient memory via daemon IPC")
    .argument("<query>", "Search query")
    .option("--data-dir <path>", "Override data directory")
    .option("-n, --limit <n>", "Max results", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <types>", "Comma-separated types: file,session,snippet,url")
    .option("--path-prefix <prefix>", "Filter by path prefix")
    .option("--since-mins <n>", "Only last N minutes")
    .option("--file-key", "Force file-backed master key", false)
    .option("--no-auto-start", "Do not auto-start daemon")
    .action(async (query, opts) => {
      const config = resolveConfig(opts);
      const hits = await withDaemonClient(
        config,
        (c) =>
          c.call<SearchHit[]>("search", {
            query,
            limit: Number(opts.limit),
            offset: Number(opts.offset),
            types: opts.type ? opts.type.split(",") : undefined,
            pathPrefix: opts.pathPrefix,
            sinceMs: opts.sinceMins ? Date.now() - Number(opts.sinceMins) * 60_000 : undefined,
          }),
        { autoStart: opts.autoStart !== false },
      );
      if (hits.length === 0) {
        console.log("No matches.");
        return;
      }
      for (const hit of hits) {
        console.log(
          `[${hit.score.toFixed(2)}] ${hit.entity.type}  ${hit.entity.title}${
            hit.entity.path ? `  (${hit.entity.path})` : ""
          }`,
        );
      }
    });

  program
    .command("recent")
    .description("Show recently seen entities via daemon IPC")
    .option("--data-dir <path>", "Override data directory")
    .option("-n, --limit <n>", "Max results", "10")
    .option("--type <types>", "Comma-separated types")
    .option("--file-key", "Force file-backed master key", false)
    .option("--no-auto-start", "Do not auto-start daemon")
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const entities = await withDaemonClient(
        config,
        (c) =>
          c.call<MemoryEntity[]>("recent", {
            limit: Number(opts.limit),
            types: opts.type ? opts.type.split(",") : undefined,
          }),
        { autoStart: opts.autoStart !== false },
      );
      for (const e of entities) {
        const when = new Date(e.lastSeenAt).toISOString();
        console.log(`${when}  ${e.type.padEnd(8)}  ${e.title}`);
      }
      if (entities.length === 0) console.log("No entities yet. Start the daemon or run the demo.");
    });

  program
    .command("context")
    .description("Narrative summary of what you were doing (noise-filtered)")
    .option("--minutes <n>", "Lookback window", "30")
    .option("--data-dir <path>", "Override data directory")
    .option("--json", "Print full JSON", false)
    .option("--file-key", "Force file-backed master key", false)
    .option("--no-auto-start", "Do not auto-start daemon")
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const ctx = await withDaemonClient(
        config,
        (c) => c.call<ContextSummary>("context", { minutes: Number(opts.minutes) }),
        { autoStart: opts.autoStart !== false },
      );
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
    });

  program
    .command("forget")
    .description("Purge memory matching a query, or all with --all")
    .argument("[query]", "Query to forget")
    .option("--all", "Delete everything", false)
    .option("--data-dir <path>", "Override data directory")
    .option("--yes", "Skip confirmation", false)
    .option("--file-key", "Force file-backed master key", false)
    .option("--no-auto-start", "Do not auto-start daemon")
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
      const result = await withDaemonClient(
        config,
        (c) =>
          c.call<{ deletedEntities: number; deletedEvents: number }>("forget", {
            query: opts.all ? "*" : query,
          }),
        { autoStart: opts.autoStart !== false },
      );
      console.log(
        `Forgot ${result.deletedEntities} entities and ${result.deletedEvents} events`,
      );
    });

  program
    .command("mcp")
    .description("Run the MCP server on stdio (thin IPC client to the daemon)")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .option("--no-auto-start", "Do not auto-start daemon")
    .action(async (opts) => {
      const config = resolveConfig(opts);
      await startMcpServer(config, { autoStart: opts.autoStart !== false });
    });

  program
    .command("init")
    .description("Create data dir + key; start daemon so vault is ready")
    .option("--data-dir <path>", "Override data directory")
    .option("--file-key", "Force file-backed master key", false)
    .option("--screen <mode>", "Screen provider for auto-started daemon", "auto")
    .action(async (opts) => {
      const config = resolveConfig(opts);
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      // Bootstrap key without leaving a racing DB open: start daemon which owns SQLite
      const { started, pid } = await ensureDaemonRunning(config, {
        screen: opts.screen ?? "auto",
      });
      const status = await withDaemonClient(config, (c) => c.call("status"), {
        autoStart: false,
      });
      const screen = await probeScreen("auto");
      console.log(
        JSON.stringify(
          {
            ok: true,
            message: "Ambient memory ready — daemon owns the vault",
            version: APP_VERSION,
            dataDir: config.dataDir,
            ipcEndpoint: ipcEndpoint(config),
            daemon: { started, pid },
            watchRoots: config.watchRoots,
            status,
            screenProbe: { resolved: screen.resolved, note: screen.note },
            sqliteBackend: detectSqliteBackend(),
          },
          null,
          2,
        ),
      );
    });

  program
    .command("doctor")
    .description("Diagnose screen/browser/key/store/IPC health")
    .option("--data-dir <path>", "Override data directory")
    .option("--screen <mode>", "Screen preference", "auto")
    .option("--file-key", "Force file-backed master key", false)
    .action(async (opts) => {
      const config = resolveConfig(opts);
      const screen = await probeScreen(opts.screen ?? "auto");
      const { readRecentBrowserHistory } = await import("./indexer/browser.js");
      const browser = readRecentBrowserHistory();
      const issues: string[] = [];
      const notes: string[] = [];
      const pid = readPid(config.pidPath);
      let doctorRemote: unknown = null;
      if (isProcessAlive(pid)) {
        try {
          doctorRemote = await withDaemonClient(config, (c) => c.call("doctor"), {
            autoStart: false,
          });
        } catch (err) {
          issues.push(
            `Daemon pid alive but IPC failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        notes.push("Daemon not running — start with: npx ambient-memory start");
        if (fs.existsSync(config.dbPath) && fs.existsSync(`${config.dbPath}.enc`)) {
          issues.push(
            "Plaintext memory.db present beside .enc while daemon is stopped — run ambient stop to re-seal",
          );
        }
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
      if (pid && !isProcessAlive(pid)) issues.push("Stale pidfile present (safe to delete via ambient stop)");

      console.log(
        JSON.stringify(
          {
            ok: issues.length === 0,
            version: APP_VERSION,
            platform: process.platform,
            node: process.version,
            sqliteBackendPreferred: detectSqliteBackend(),
            ipcEndpoint: ipcEndpoint(config),
            screen,
            browser: browser.result,
            doctor: doctorRemote,
            sealedAtRest: MemoryStore.isSealedAtRest(config.dbPath),
            redactionKinds: listRedactionKinds().length,
            telemetry: false,
            crypto: {
              fieldEncryption: true,
              sealedEnvelopeAtRest: true,
              ftsPlaintextWhileUnlocked: true,
              note: "FTS holds redacted plaintext while the daemon holds the vault open — intentional search tradeoff",
            },
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
