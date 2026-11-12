export {
  buildConfig,
  defaultDataDir,
  defaultWatchRoots,
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_NOISY_APPS,
  APP_NAME,
  APP_VERSION,
} from "./config/defaults.js";
export type { AmbientConfig } from "./config/defaults.js";
export { EnvelopeCrypto } from "./crypto/envelope.js";
export { loadOrCreateMasterKey, readKeyBackendMeta } from "./crypto/key-store.js";
export type { KeyBackend, KeyLoadResult } from "./crypto/key-store.js";
export { redactSecrets, listRedactionKinds } from "./privacy/redact.js";
export { MemoryStore, openStore, openStoreAsync, hashContent } from "./store/memory-store.js";
export type {
  MemoryEntity,
  SearchHit,
  SearchOptions,
  ContextSummary,
  EntityType,
} from "./store/memory-store.js";
export { buildFtsQuery, rankScore, tokenize } from "./store/search.js";
export {
  detectSqliteBackend,
  openSqliteDatabase,
  openSqliteDatabaseSync,
} from "./store/sqlite.js";
export type { SqliteBackend, SqliteDatabase } from "./store/sqlite.js";
export { AmbientDaemon } from "./indexer/daemon.js";
export { ensureDaemonRunning, withDaemonClient, isDaemonReachable } from "./indexer/ensure-daemon.js";
export {
  isNoisyApp,
  shouldIndexFocus,
  summarizeSessions,
  dedupeByTitlePath,
  focusDedupeKey,
} from "./indexer/noise.js";
export { startFileWatcher, watcherTestUtils } from "./indexer/watcher.js";
export {
  resolveScreenProvider,
  SimulatedScreenProvider,
  probeScreen,
} from "./indexer/screen.js";
export {
  readRecentBrowserHistory,
  writeChromeHistoryFixture,
  writeFirefoxPlacesFixture,
} from "./indexer/browser.js";
export { acquirePidFile, releasePidFile, readPid, isProcessAlive } from "./indexer/pidfile.js";
export { RotatingLogger } from "./indexer/logging.js";
export { createMcpHandlers, startMcpServer } from "./mcp/server.js";
export {
  handleMemoryTool,
  handleMemoryToolRemote,
  MCP_TOOLS,
  MCP_PROMPTS,
} from "./mcp/tools.js";
export { IpcClient } from "./ipc/client.js";
export { ipcEndpoint } from "./ipc/paths.js";
export { runCli } from "./cli.js";
