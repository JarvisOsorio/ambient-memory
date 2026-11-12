import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AmbientConfig } from "../config/defaults.js";
import type { MemoryStore } from "../store/memory-store.js";
import { hashContent } from "../store/memory-store.js";

const TEXTISH = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".scss",
  ".html",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".env.example",
  ".mdx",
  ".vue",
  ".svelte",
  ".astro",
]);

export interface WatcherStats {
  indexed: number;
  skippedUnchanged: number;
  skippedBinary: number;
  skippedSize: number;
  skippedExcluded: number;
  skippedSymlink: number;
  errors: number;
}

export interface WatcherHandle {
  close(): Promise<void>;
  roots: string[];
  stats: WatcherStats;
}

function globToRegExp(glob: string): RegExp {
  // Minimal glob → regex for common ** / * patterns
  let g = glob;
  const neg = g.startsWith("!");
  if (neg) g = g.slice(1);
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, ":::DBL:::")
    .replace(/\*\*/g, ":::DBL:::")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/:::DBL:::/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesIgnore(filePath: string, globs: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  let ignored = false;
  for (const g of globs) {
    const neg = g.startsWith("!");
    const re = globToRegExp(g);
    // Also test basename-only and relative-ish forms
    const candidates = [normalized, path.basename(normalized)];
    for (const c of candidates) {
      if (re.test(c) || normalized.includes(g.replace(/\*\*/g, "").replace(/\*/g, ""))) {
        // Prefer path segment checks for common dirs
      }
    }
    // Robust segment matching for well-known patterns
    if (
      /node_modules|\.git\/|\.ambient-memory|\/dist\/|\/build\/|\/\.next\/|\/coverage\//.test(
        normalized + "/",
      )
    ) {
      ignored = true;
    }
    if (neg && re.test(normalized)) ignored = false;
    else if (!neg && (re.test(normalized) || segmentMatch(normalized, g))) ignored = true;
  }
  // Hard denies for secret-ish filenames
  const base = path.basename(normalized);
  if (
    base === ".env" ||
    /^\.env\./.test(base) && base !== ".env.example" ||
    /\.(pem|key)$/i.test(base) ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base === "credentials.json" ||
    base === "secrets.json"
  ) {
    return true;
  }
  return ignored;
}

function segmentMatch(normalized: string, glob: string): boolean {
  const core = glob.replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\*/g, "");
  if (!core || core.includes("{")) return false;
  return normalized.split("/").includes(core.replace(/\/$/, "")) || normalized.includes(`/${core}/`);
}

function isUnderExclude(filePath: string, excludes: string[]): boolean {
  const resolved = path.resolve(filePath);
  return excludes.some((ex) => {
    const e = path.resolve(ex);
    return resolved === e || resolved.startsWith(e + path.sep);
  });
}

function isIndexableFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.startsWith(".") && base !== ".env.example") return false;
  const ext = path.extname(filePath).toLowerCase();
  if (TEXTISH.has(ext)) return true;
  if (!ext && base.length < 64) return true;
  return false;
}

function readSnippet(
  filePath: string,
  maxBytes: number,
  maxChars: number,
): { body?: string; skip?: "binary" | "size" | "error" } {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return { skip: "error" };
    if (!stat.isFile()) return { skip: "error" };
    if (stat.size > maxBytes) return { skip: "size" };
    const buf = fs.readFileSync(filePath);
    if (buf.includes(0)) return { skip: "binary" };
    return { body: buf.toString("utf8").slice(0, maxChars) };
  } catch {
    return { skip: "error" };
  }
}

export function startFileWatcher(
  store: MemoryStore,
  roots: string[],
  options?: {
    persistent?: boolean;
    config?: AmbientConfig;
    onIndex?: (path: string, reason: string) => void;
    relateToSessionId?: () => string | undefined;
  },
): WatcherHandle {
  const config = options?.config ?? store.config;
  const stats: WatcherStats = {
    indexed: 0,
    skippedUnchanged: 0,
    skippedBinary: 0,
    skippedSize: 0,
    skippedExcluded: 0,
    skippedSymlink: 0,
    errors: 0,
  };

  const existingRoots = roots.filter((r) => {
    try {
      return fs.existsSync(r);
    } catch {
      return false;
    }
  });

  const watchList =
    existingRoots.length > 0 ? existingRoots : [process.cwd()].filter((r) => fs.existsSync(r));

  const indexFile = (filePath: string, reason: string) => {
    try {
      const resolved = path.resolve(filePath);
      if (isUnderExclude(resolved, config.excludePaths)) {
        stats.skippedExcluded += 1;
        return;
      }
      if (matchesIgnore(resolved, config.ignoreGlobs)) {
        stats.skippedExcluded += 1;
        return;
      }
      try {
        if (fs.lstatSync(resolved).isSymbolicLink()) {
          stats.skippedSymlink += 1;
          return;
        }
      } catch {
        stats.errors += 1;
        return;
      }
      if (!isIndexableFile(resolved)) return;

      const snip = readSnippet(resolved, config.maxFileBytes, config.maxSnippetChars);
      if (snip.skip === "binary") {
        stats.skippedBinary += 1;
        return;
      }
      if (snip.skip === "size") {
        stats.skippedSize += 1;
        return;
      }
      if (snip.skip === "error") {
        stats.errors += 1;
        return;
      }

      const title = path.basename(resolved);
      const body = snip.body;
      const hash = hashContent(title, body, resolved);
      const existing = store.findByPath(resolved);
      if (existing?.contentHash === hash) {
        store.upsertEntity({
          type: "file",
          title,
          path: resolved,
          body,
          contentHash: hash,
          source: "watcher",
          metadata: { reason },
          skipIfUnchanged: true,
        });
        stats.skippedUnchanged += 1;
        return;
      }

      const entity = store.upsertEntity({
        type: "file",
        title,
        path: resolved,
        body,
        contentHash: hash,
        source: "watcher",
        metadata: { reason, bytes: fs.statSync(resolved).size },
      });
      if (!entity) return;
      store.addEvent({
        kind: `file_${reason}`,
        summary: `${reason}: ${resolved}`,
        entityId: entity.id,
        payload: { path: resolved },
      });

      const sessionId = options?.relateToSessionId?.();
      if (sessionId) {
        store.relate(entity.id, sessionId, "opened_during", 1);
      }

      stats.indexed += 1;
      options?.onIndex?.(resolved, reason);
    } catch {
      stats.errors += 1;
    }
  };

  const watcher: FSWatcher = chokidar.watch(watchList, {
    ignoreInitial: false,
    persistent: options?.persistent ?? true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    ignored: (p: string) => matchesIgnore(p, config.ignoreGlobs),
    depth: 8,
    followSymlinks: false,
  });

  watcher.on("add", (p) => indexFile(p, "created"));
  watcher.on("change", (p) => indexFile(p, "modified"));
  watcher.on("unlink", (p) => {
    store.addEvent({
      kind: "file_deleted",
      summary: `deleted: ${p}`,
      payload: { path: p },
    });
  });

  return {
    roots: watchList,
    stats,
    async close() {
      await watcher.close();
    },
  };
}

/** Pure helpers exported for tests */
export const watcherTestUtils = {
  matchesIgnore,
  isUnderExclude,
  isIndexableFile,
  globToRegExp,
  contentHash: (title: string, body?: string, p?: string) =>
    crypto.createHash("sha256").update(`${title}\n${body ?? ""}\n${p ?? ""}`).digest("hex").slice(0, 32),
};
