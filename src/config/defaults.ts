import os from "node:os";
import path from "node:path";

export const APP_NAME = "ambient-memory";
export const APP_VERSION = "0.2.1";

export function defaultDataDir(home = os.homedir()): string {
  return path.join(home, ".ambient-memory");
}

export function defaultWatchRoots(home = os.homedir()): string[] {
  const candidates = [
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
    process.cwd(),
  ];
  return [...new Set(candidates)];
}

export const DEFAULT_IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/.ambient-memory/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/.cache/**",
  "**/*.pyc",
  "**/__pycache__/**",
  "**/.DS_Store",
  "**/*.swp",
  "**/*~",
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "**/credentials.json",
  "**/secrets.json",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
];

export interface AmbientConfig {
  dataDir: string;
  dbPath: string;
  keyPath: string;
  pidPath: string;
  logPath: string;
  watchRoots: string[];
  excludePaths: string[];
  ignoreGlobs: string[];
  screenIntervalMs: number;
  browserEnabled: boolean;
  redactSecrets: boolean;
  preferKeychain: boolean;
  forceFileKey: boolean;
  logMaxBytes: number;
  maxFileBytes: number;
  maxSnippetChars: number;
  dryRun: boolean;
  telemetry: false;
  screenProvider?: "auto" | "simulated" | "none";
  browserHistoryPaths?: string[];
}

export function buildConfig(overrides: Partial<AmbientConfig> = {}): AmbientConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  return {
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, "memory.db"),
    keyPath: overrides.keyPath ?? path.join(dataDir, "master.key"),
    pidPath: overrides.pidPath ?? path.join(dataDir, "daemon.pid"),
    logPath: overrides.logPath ?? path.join(dataDir, "daemon.log"),
    watchRoots: overrides.watchRoots ?? defaultWatchRoots(),
    excludePaths: overrides.excludePaths ?? [],
    ignoreGlobs: overrides.ignoreGlobs ?? [...DEFAULT_IGNORE_GLOBS],
    screenIntervalMs: overrides.screenIntervalMs ?? 15_000,
    browserEnabled: overrides.browserEnabled ?? true,
    redactSecrets: overrides.redactSecrets ?? true,
    preferKeychain: overrides.preferKeychain ?? true,
    forceFileKey: overrides.forceFileKey ?? false,
    logMaxBytes: overrides.logMaxBytes ?? 5 * 1024 * 1024,
    maxFileBytes: overrides.maxFileBytes ?? 512_000,
    maxSnippetChars: overrides.maxSnippetChars ?? 4000,
    dryRun: overrides.dryRun ?? false,
    telemetry: false,
    screenProvider: overrides.screenProvider ?? "auto",
    browserHistoryPaths: overrides.browserHistoryPaths,
  };
}
