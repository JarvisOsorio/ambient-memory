/**
 * Zero-native SQLite adapter.
 * - Node 22+: built-in `node:sqlite` (DatabaseSync)
 * - Node 20 / fallback: `sql.js` WASM
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
export type SqliteBackend = "node-sqlite" | "sql.js";

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  readonly backend: SqliteBackend;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  /** Best-effort WAL checkpoint before close (node-sqlite only). */
  checkpoint(): void;
  /** Flush in-memory backends to dbPath before seal/encrypt. */
  persist(): void;
  close(): void;
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0] ?? 0);
}

function canUseNodeSqlite(): boolean {
  if (process.env.AMBIENT_SQLITE_BACKEND === "sql.js") return false;
  if (process.env.AMBIENT_SQLITE_BACKEND === "node-sqlite") return true;
  if (nodeMajor() < 22) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync?: unknown;
    };
    return typeof mod.DatabaseSync === "function";
  } catch {
    return false;
  }
}

function wrapNodeSqlite(
  dbPath: string,
  options: { readBigInts?: boolean } = {},
): SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      opts?: { readBigInts?: boolean },
    ) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        get(...params: unknown[]): Record<string, unknown> | undefined;
        all(...params: unknown[]): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };
  const raw = new DatabaseSync(dbPath, options);
  const api: SqliteDatabase = {
    backend: "node-sqlite",
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => {
          const r = stmt.run(...params);
          return { changes: Number(r.changes ?? 0), lastInsertRowid: r.lastInsertRowid ?? 0 };
        },
        get: (...params) => {
          const row = stmt.get(...params);
          return row ? ({ ...row } as Record<string, unknown>) : undefined;
        },
        all: (...params) =>
          stmt.all(...params).map((row) => ({ ...row }) as Record<string, unknown>),
      };
    },
    transaction: <T>(fn: () => T) => {
      return () => {
        raw.exec("BEGIN");
        try {
          const out = fn();
          raw.exec("COMMIT");
          return out;
        } catch (err) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            /* ignore */
          }
          throw err;
        }
      };
    },
    checkpoint: () => {
      try {
        raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* ignore */
      }
    },
    persist: () => {
      /* file-backed already */
    },
    close: () => raw.close(),
  };
  return api;
}

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
    reset(): void;
  };
  export(): Uint8Array;
  close(): void;
};

async function loadSqlJs(): Promise<{
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
}> {
  const require = createRequire(import.meta.url);
  // Prefer asm.js build for reliable Node init without separate wasm fetch.
  const initSqlJs = require("sql.js/dist/sql-asm.js") as (opts?: {
    locateFile?: (file: string) => string;
  }) => Promise<{ Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase }>;
  return initSqlJs();
}

function wrapSqlJs(dbPath: string, raw: SqlJsDatabase): SqliteDatabase {
  const persist = () => {
    const data = Buffer.from(raw.export());
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, dbPath);
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* ignore */
    }
  };

  const prepare = (sql: string): SqliteStatement => {
    return {
      run: (...params) => {
        raw.run(sql, params.length ? params : undefined);
        // sql.js does not expose changes cheaply — approximate via getRowsModified if present
        const changes =
          typeof (raw as unknown as { getRowsModified?: () => number }).getRowsModified ===
          "function"
            ? (raw as unknown as { getRowsModified: () => number }).getRowsModified()
            : 0;
        return { changes, lastInsertRowid: 0 };
      },
      get: (...params) => {
        const stmt = raw.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          if (!stmt.step()) return undefined;
          return { ...stmt.getAsObject() };
        } finally {
          stmt.free();
        }
      },
      all: (...params) => {
        const stmt = raw.prepare(sql);
        const rows: Array<Record<string, unknown>> = [];
        try {
          if (params.length) stmt.bind(params);
          while (stmt.step()) rows.push({ ...stmt.getAsObject() });
          return rows;
        } finally {
          stmt.free();
        }
      },
    };
  };

  return {
    backend: "sql.js",
    exec: (sql) => {
      raw.exec(sql);
    },
    prepare,
    transaction: <T>(fn: () => T) => {
      return () => {
        raw.run("BEGIN");
        try {
          const out = fn();
          raw.run("COMMIT");
          return out;
        } catch (err) {
          try {
            raw.run("ROLLBACK");
          } catch {
            /* ignore */
          }
          throw err;
        }
      };
    },
    checkpoint: () => {
      /* no WAL for sql.js */
    },
    persist,
    close: () => {
      try {
        persist();
      } finally {
        raw.close();
      }
    },
  };
}

export async function openSqliteDatabase(
  dbPath: string,
  options: { readBigInts?: boolean } = {},
): Promise<SqliteDatabase> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  if (canUseNodeSqlite()) {
    return wrapNodeSqlite(dbPath, options);
  }
  const SQL = await loadSqlJs();
  const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const raw = existing ? new SQL.Database(existing) : new SQL.Database();
  return wrapSqlJs(dbPath, raw);
}

/** Sync open — Node 22+ node:sqlite only. Throws if unavailable. */
export function openSqliteDatabaseSync(
  dbPath: string,
  options: { readBigInts?: boolean } = {},
): SqliteDatabase {
  if (!canUseNodeSqlite()) {
    throw new Error(
      "Synchronous SQLite open requires Node 22+ (node:sqlite). Use MemoryStore.openAsync() or set AMBIENT_SQLITE_BACKEND.",
    );
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  return wrapNodeSqlite(dbPath, options);
}

export function detectSqliteBackend(): SqliteBackend {
  return canUseNodeSqlite() ? "node-sqlite" : "sql.js";
}

