import fs from "node:fs";
import type { AmbientConfig } from "../config/defaults.js";
import { startIpcServer, type IpcServerHandle } from "../ipc/server.js";
import { ipcEndpoint } from "../ipc/paths.js";
import { MemoryStore } from "../store/memory-store.js";
import { readRecentBrowserHistory } from "./browser.js";
import { RotatingLogger } from "./logging.js";
import { focusDedupeKey, shouldIndexFocus } from "./noise.js";
import {
  acquirePidFile,
  isProcessAlive,
  readPid,
  releasePidFile,
} from "./pidfile.js";
import {
  resolveScreenProvider,
  SimulatedScreenProvider,
  type ScreenProvider,
} from "./screen.js";
import { startFileWatcher, type WatcherHandle, type WatcherStats } from "./watcher.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  dataDir: string;
  watchRoots: string[];
  screenProvider?: string;
  browser?: { indexed: number; skippedReason?: string; sourcePath?: string };
  watcher?: WatcherStats;
  dryRun?: boolean;
  store?: ReturnType<MemoryStore["status"]>;
  ipcEndpoint?: string;
  sqliteBackend?: string;
}

export class AmbientDaemon {
  readonly config: AmbientConfig;
  store!: MemoryStore;
  private watcher?: WatcherHandle;
  private screen?: ScreenProvider;
  private screenTimer?: NodeJS.Timeout;
  private browserTimer?: NodeJS.Timeout;
  private lastSessionId?: string;
  private lastFocusKey?: string;
  private lastFocusAt?: number;
  private started = false;
  private logger: RotatingLogger;
  private owningPid = false;
  private ipc?: IpcServerHandle;
  browserNote?: { indexed: number; skippedReason?: string; sourcePath?: string };

  constructor(config: AmbientConfig, store?: MemoryStore) {
    this.config = config;
    this.logger = new RotatingLogger({
      logPath: config.logPath,
      maxBytes: config.logMaxBytes,
    });
    if (store) this.store = store;
  }

  async start(): Promise<void> {
    if (this.started) return;
    fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });

    const pid = acquirePidFile(this.config.pidPath);
    if (!pid.ok) {
      throw new Error(`Daemon already running (pid ${pid.pid})`);
    }
    this.owningPid = true;
    if (pid.recoveredStale) {
      this.logger.warn("cleared_stale_pidfile");
    }

    if (!this.store) {
      this.store = await MemoryStore.openAsync(this.config);
    }

    this.ipc = await startIpcServer(this.config, this.store, this);
    this.logger.info("ipc_listen", { endpoint: this.ipc.endpoint });

    this.watcher = startFileWatcher(this.store, this.config.watchRoots, {
      config: this.config,
      relateToSessionId: () => this.lastSessionId,
      onIndex: (p, reason) => this.logger.info("file_indexed", { path: p, reason }),
    });
    this.store.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('watch_roots', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(this.watcher.roots));

    const pref = this.config.screenProvider ?? "auto";
    this.screen = await resolveScreenProvider(
      pref === "simulated" ? "simulated" : pref,
      new SimulatedScreenProvider(),
    );
    this.store.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('screen_provider', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(this.screen.name);

    this.screenTimer = setInterval(() => {
      void this.captureScreen();
    }, this.config.screenIntervalMs);
    void this.captureScreen();

    if (this.config.browserEnabled) {
      this.indexBrowser();
      this.browserTimer = setInterval(() => this.indexBrowser(), 30 * 60 * 1000);
    }

    this.store.addEvent({
      kind: "daemon_start",
      summary: `Ambient daemon started (screen=${this.screen.name}, key=${this.store.crypto.keyBackend}, sqlite=${this.store.db.backend})`,
      payload: {
        roots: this.watcher.roots,
        pid: process.pid,
        keyBackend: this.store.crypto.keyBackend,
        sqliteBackend: this.store.db.backend,
        dryRun: this.config.dryRun,
        ipc: this.ipc.endpoint,
      },
    });

    this.started = true;
    this.logger.info("daemon_started", {
      pid: process.pid,
      screen: this.screen.name,
      key: this.store.crypto.keyBackend,
      sqlite: this.store.db.backend,
      dryRun: this.config.dryRun,
      roots: this.watcher.roots.length,
      ipc: this.ipc.endpoint,
    });
  }

  private async captureScreen(): Promise<void> {
    if (!this.screen) return;
    try {
      const snap = await this.screen.capture();
      if (!snap) return;

      const decision = shouldIndexFocus(
        {
          appName: snap.appName,
          windowTitle: snap.windowTitle,
          capturedAt: snap.capturedAt,
        },
        {
          lastKey: this.lastFocusKey,
          lastAt: this.lastFocusAt,
          dedupeWindowMs: this.config.focusDedupeWindowMs,
          noisyApps: this.config.noisyApps,
        },
      );

      if (!decision.index) {
        if (decision.reason === "deduped" && this.lastSessionId) {
          // Touch last_seen without rewriting body
          this.store.upsertEntity({
            id: this.lastSessionId,
            type: "session",
            title: `${snap.appName}: ${snap.windowTitle}`,
            source: "screen",
            skipIfUnchanged: true,
            metadata: {
              appName: snap.appName,
              windowTitle: snap.windowTitle,
              provider: snap.provider,
              noisy: decision.noisy,
            },
          });
        }
        this.lastFocusKey = focusDedupeKey(snap);
        this.lastFocusAt = snap.capturedAt;
        return;
      }

      const title = `${snap.appName}: ${snap.windowTitle}`;
      const isNew =
        !this.lastSessionId || this.store.getEntity(this.lastSessionId)?.title !== title;

      const session = this.store.upsertEntity({
        id: isNew ? undefined : this.lastSessionId,
        type: "session",
        title,
        body: `Active window via ${snap.provider}`,
        source: "screen",
        metadata: {
          appName: snap.appName,
          windowTitle: snap.windowTitle,
          provider: snap.provider,
          noisy: decision.noisy,
        },
      });
      if (!session) return;

      if (isNew && this.lastSessionId && this.lastSessionId !== session.id) {
        this.store.endSession(this.lastSessionId);
      }
      if (isNew) {
        this.store.beginSession(session.title, session.id);
      }
      this.lastSessionId = session.id;
      this.lastFocusKey = focusDedupeKey(snap);
      this.lastFocusAt = snap.capturedAt;
      this.store.addEvent({
        kind: "screen_focus",
        summary: `${snap.appName} — ${snap.windowTitle}`,
        entityId: session.id,
        payload: { ...snap, noisy: decision.noisy },
      });
    } catch (err) {
      this.logger.warn("screen_capture_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private indexBrowser(): void {
    try {
      const { entries, result } = readRecentBrowserHistory({
        historyPaths: this.config.browserHistoryPaths,
      });
      this.browserNote = result;
      for (const entry of entries) {
        const entity = this.store.upsertEntity({
          type: "url",
          title: entry.title,
          path: entry.url,
          body: entry.url,
          source: `browser:${entry.source}`,
          metadata: { lastVisitAt: entry.lastVisitAt },
          seenAt: entry.lastVisitAt,
        });
        if (!entity) continue;
        this.store.addEvent({
          kind: "browser_visit",
          summary: `Visited ${entry.title}`,
          entityId: entity.id,
          occurredAt: entry.lastVisitAt,
          payload: { url: entry.url, source: entry.source },
        });
        if (this.lastSessionId) {
          this.store.relate(entity.id, this.lastSessionId, "opened_during", 0.8);
        }
      }
      this.logger.info("browser_hook", {
        indexed: result.indexed,
        skippedReason: result.skippedReason,
      });
    } catch (err) {
      this.logger.warn("browser_index_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.browserNote = {
        indexed: 0,
        skippedReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stop(seal = true): Promise<void> {
    if (this.screenTimer) clearInterval(this.screenTimer);
    if (this.browserTimer) clearInterval(this.browserTimer);
    if (this.watcher) await this.watcher.close();
    if (this.ipc) {
      await this.ipc.close();
      this.ipc = undefined;
    }
    if (this.lastSessionId) {
      try {
        this.store.endSession(this.lastSessionId);
      } catch {
        /* ignore */
      }
    }
    if (this.store) {
      try {
        this.store.addEvent({
          kind: "daemon_stop",
          summary: "Ambient daemon stopped",
        });
      } catch {
        /* store may already be closed */
      }
      this.store.close(seal);
    }
    if (this.owningPid) {
      releasePidFile(this.config.pidPath, process.pid);
      this.owningPid = false;
    }
    this.started = false;
    this.logger.info("daemon_stopped");
  }

  getStatus(): DaemonStatus {
    const pid = readPid(this.config.pidPath);
    return {
      running: this.started || isProcessAlive(pid),
      pid: pid ?? undefined,
      dataDir: this.config.dataDir,
      watchRoots: this.watcher?.roots ?? this.config.watchRoots,
      screenProvider: this.screen?.name,
      browser: this.browserNote,
      watcher: this.watcher?.stats,
      dryRun: this.config.dryRun,
      ipcEndpoint: this.ipc?.endpoint ?? ipcEndpoint(this.config),
      sqliteBackend: this.store?.db.backend,
      store:
        this.store && (this.started || fs.existsSync(this.config.dbPath))
          ? this.store.status()
          : undefined,
    };
  }
}

export { readPid, isProcessAlive } from "./pidfile.js";

export async function runDaemonForeground(config: AmbientConfig): Promise<void> {
  const daemon = new AmbientDaemon(config);
  await daemon.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await daemon.stop(true);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise(() => {
    /* run until signal */
  });
}
