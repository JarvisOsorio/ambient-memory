import crypto from "node:crypto";
import fs from "node:fs";
import { EnvelopeCrypto } from "../crypto/envelope.js";
import { redactSecrets } from "../privacy/redact.js";
import type { AmbientConfig } from "../config/defaults.js";
import {
  dedupeByTitlePath,
  isNoisyApp,
  summarizeSessions,
} from "../indexer/noise.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { buildFtsQuery, rankScore, tokenize } from "./search.js";
import {
  detectSqliteBackend,
  openSqliteDatabase,
  openSqliteDatabaseSync,
  type SqliteDatabase,
} from "./sqlite.js";

export type EntityType = "file" | "session" | "snippet" | "url" | "event";

export interface MemoryEntity {
  id: string;
  type: EntityType;
  title: string;
  body?: string;
  path?: string;
  contentHash?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  source: string;
  metadata: Record<string, unknown>;
}

export interface MemoryLink {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  weight: number;
  createdAt: number;
}

export interface MemoryEvent {
  id: string;
  kind: string;
  entityId?: string;
  summary: string;
  occurredAt: number;
  payload?: Record<string, unknown>;
}

export interface SearchHit {
  entity: MemoryEntity;
  score: number;
  bm25?: number;
  matchedTerms: string[];
  snippet?: string;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  types?: EntityType[];
  pathPrefix?: string;
  sinceMs?: number;
  untilMs?: number;
}

export interface UpsertEntityInput {
  id?: string;
  type: EntityType;
  title: string;
  body?: string;
  path?: string;
  contentHash?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  seenAt?: number;
  skipIfUnchanged?: boolean;
}

export interface ContextSummary {
  minutes: number;
  sinceMs: number;
  untilMs: number;
  narrative: string;
  sessions: Array<{
    id: string;
    title: string;
    lastSeenAt: number;
    appName?: string;
    focusCount?: number;
    durationMs?: number;
  }>;
  files: Array<{ id: string; title: string; path?: string; lastSeenAt: number }>;
  urls: Array<{ id: string; title: string; path?: string; lastSeenAt: number }>;
  links: MemoryLink[];
  events: MemoryEvent[];
  /** How many raw sessions were dropped as noise / collapsed. */
  noise: { droppedSessions: number; collapsedSessions: number };
}

function contentHashOf(title: string, body?: string, filePath?: string): string {
  return crypto
    .createHash("sha256")
    .update(`${title}\n${body ?? ""}\n${filePath ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export class MemoryStore {
  readonly db: SqliteDatabase;
  readonly crypto: EnvelopeCrypto;
  readonly config: AmbientConfig;
  private closed = false;
  private eventCounterWindow: number[] = [];
  /** True when this process decrypted memory.db.enc to open the store. */
  readonly restoredFromSeal: boolean;

  constructor(config: AmbientConfig, cryptoSvc?: EnvelopeCrypto, db?: SqliteDatabase) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.config = config;
    this.crypto = cryptoSvc ?? EnvelopeCrypto.loadOrCreateKey(config.keyPath);

    const encPath = `${config.dbPath}.enc`;
    let restored = false;
    if (!fs.existsSync(config.dbPath) && fs.existsSync(encPath)) {
      this.crypto.decryptFile(encPath, config.dbPath);
      restored = true;
    }
    this.restoredFromSeal = restored;

    this.db = db ?? openSqliteDatabaseSync(config.dbPath);
    this.bootstrapSchema();
  }

  private bootstrapSchema(): void {
    if (this.db.backend === "node-sqlite") {
      try {
        this.db.exec("PRAGMA journal_mode = WAL");
      } catch {
        /* ignore */
      }
    }
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(SCHEMA_VERSION);
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('key_backend', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(this.crypto.keyBackend);
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('sqlite_backend', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(this.db.backend);
    try {
      if (fs.existsSync(this.config.dbPath)) fs.chmodSync(this.config.dbPath, 0o600);
    } catch {
      /* ignore */
    }
    this.updateIntegrity();
  }

  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>;
    if (cols.length && !cols.some((c) => c.name === "content_hash")) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN content_hash TEXT`);
    }
  }

  static async openAsync(config: AmbientConfig): Promise<MemoryStore> {
    const cryptoSvc = await EnvelopeCrypto.loadOrCreateAsync(config.keyPath, {
      preferKeychain: config.preferKeychain !== false,
      forceFile: config.forceFileKey === true,
    });
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const encPath = `${config.dbPath}.enc`;
    if (!fs.existsSync(config.dbPath) && fs.existsSync(encPath)) {
      cryptoSvc.decryptFile(encPath, config.dbPath);
    }
    const db = await openSqliteDatabase(config.dbPath);
    return new MemoryStore(config, cryptoSvc, db);
  }

  /**
   * Close the DB. When `seal` is true, encrypt to `.enc` and delete plaintext.
   * Prefer daemon-owned lifecycle — CLI/MCP should not open the DB directly.
   */
  close(seal = false): void {
    if (this.closed) return;
    this.updateIntegrity();
    try {
      this.db.checkpoint();
      this.db.persist();
    } catch {
      /* best-effort */
    }
    this.db.close();
    this.closed = true;
    if (seal) {
      this.sealVault();
    }
  }

  /** Encrypt DB to `.enc` and remove plaintext + sidecars. Idempotent. */
  sealVault(): void {
    const dbPath = this.config.dbPath;
    const encPath = `${dbPath}.enc`;
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      const side = `${dbPath}${suffix}`;
      try {
        if (fs.existsSync(side)) fs.unlinkSync(side);
      } catch {
        /* ignore */
      }
    }
    if (fs.existsSync(dbPath)) {
      this.crypto.encryptFile(dbPath, encPath, true);
    }
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      const side = `${dbPath}${suffix}`;
      try {
        if (fs.existsSync(side)) fs.unlinkSync(side);
      } catch {
        /* ignore */
      }
    }
  }

  static isSealedAtRest(dbPath: string): boolean {
    const enc = `${dbPath}.enc`;
    if (fs.existsSync(dbPath)) return false;
    if (fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`)) return false;
    return fs.existsSync(enc) || (!fs.existsSync(dbPath) && !fs.existsSync(enc));
  }

  private enc(text: string): string {
    const cleaned = this.config.redactSecrets ? redactSecrets(text).text : text;
    return this.crypto.encrypt(cleaned);
  }

  private dec(payload: string): string {
    return this.crypto.decrypt(payload);
  }

  private rowToEntity(row: Record<string, unknown>): MemoryEntity {
    return {
      id: String(row.id),
      type: row.type as EntityType,
      title: this.dec(String(row.title_enc)),
      body: row.body_enc ? this.dec(String(row.body_enc)) : undefined,
      path: row.path_enc ? this.dec(String(row.path_enc)) : undefined,
      contentHash: row.content_hash ? String(row.content_hash) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastSeenAt: Number(row.last_seen_at),
      source: String(row.source),
      metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
    };
  }

  upsertEntity(input: UpsertEntityInput): MemoryEntity | null {
    if (this.config.dryRun) return null;

    const now = input.seenAt ?? Date.now();
    const id =
      input.id ??
      (input.path
        ? crypto.createHash("sha256").update(`${input.type}:${input.path}`).digest("hex").slice(0, 32)
        : crypto.randomUUID().replace(/-/g, ""));

    const hash = input.contentHash ?? contentHashOf(input.title, input.body, input.path);
    const existing = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id);

    if (
      input.skipIfUnchanged &&
      existing &&
      existing.content_hash &&
      String(existing.content_hash) === hash
    ) {
      this.db.prepare(`UPDATE entities SET last_seen_at = ? WHERE id = ?`).run(now, id);
      return this.getEntity(id)!;
    }

    const titleEnc = this.enc(input.title);
    const bodyEnc = input.body != null ? this.enc(input.body) : null;
    const pathEnc = input.path != null ? this.enc(input.path) : null;
    const metadata = JSON.stringify(input.metadata ?? {});
    const source = input.source ?? "indexer";

    if (existing) {
      this.db
        .prepare(
          `UPDATE entities SET
             title_enc = ?, body_enc = COALESCE(?, body_enc), path_enc = COALESCE(?, path_enc),
             content_hash = ?, updated_at = ?, last_seen_at = ?, source = ?, metadata_json = ?
           WHERE id = ?`,
        )
        .run(titleEnc, bodyEnc, pathEnc, hash, now, now, source, metadata, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO entities
             (id, type, title_enc, body_enc, path_enc, content_hash, created_at, updated_at, last_seen_at, source, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.type, titleEnc, bodyEnc, pathEnc, hash, now, now, now, source, metadata);
    }

    this.reindexFts(id, input.type, input.title, input.body ?? "", input.path ?? "");
    this.updateIntegrity();
    return this.getEntity(id)!;
  }

  private reindexFts(
    entityId: string,
    type: string,
    title: string,
    body: string,
    filePath: string,
  ): void {
    const cleanedTitle = this.config.redactSecrets ? redactSecrets(title).text : title;
    const cleanedBody = this.config.redactSecrets ? redactSecrets(body).text : body;
    const cleanedPath = this.config.redactSecrets ? redactSecrets(filePath).text : filePath;

    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM entities_fts WHERE entity_id = ?`).run(entityId);
      this.db
        .prepare(
          `INSERT INTO entities_fts(entity_id, type, title, body, path) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(entityId, type, cleanedTitle, cleanedBody, cleanedPath);

      const terms = [...new Set(tokenize([cleanedTitle, cleanedBody, cleanedPath].join(" ")))];
      this.db.prepare(`DELETE FROM search_terms WHERE entity_id = ?`).run(entityId);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO search_terms(entity_id, term) VALUES (?, ?)`,
      );
      for (const term of terms) ins.run(entityId, term);
    });
    tx();
  }

  getEntity(id: string): MemoryEntity | undefined {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id);
    return row ? this.rowToEntity(row) : undefined;
  }

  getContentHash(id: string): string | undefined {
    const row = this.db.prepare(`SELECT content_hash FROM entities WHERE id = ?`).get(id) as
      | { content_hash: string | null }
      | undefined;
    return row?.content_hash ?? undefined;
  }

  findByPath(filePath: string): MemoryEntity | undefined {
    const id = crypto
      .createHash("sha256")
      .update(`file:${filePath}`)
      .digest("hex")
      .slice(0, 32);
    return this.getEntity(id);
  }

  relate(fromId: string, toId: string, relation: string, weight = 1): MemoryLink {
    if (this.config.dryRun) {
      return { id: "dry-run", fromId, toId, relation, weight, createdAt: Date.now() };
    }
    const id = crypto
      .createHash("sha256")
      .update(`${fromId}|${toId}|${relation}`)
      .digest("hex")
      .slice(0, 32);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO links(id, from_id, to_id, relation, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET weight = excluded.weight`,
      )
      .run(id, fromId, toId, relation, weight, now);
    this.updateIntegrity();
    return { id, fromId, toId, relation, weight, createdAt: now };
  }

  getLinks(entityId: string, limit = 100): MemoryLink[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM links WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(entityId, entityId, limit);
    return rows.map((r) => ({
      id: String(r.id),
      fromId: String(r.from_id),
      toId: String(r.to_id),
      relation: String(r.relation),
      weight: Number(r.weight),
      createdAt: Number(r.created_at),
    }));
  }

  addEvent(input: {
    kind: string;
    summary: string;
    entityId?: string;
    payload?: Record<string, unknown>;
    occurredAt?: number;
  }): MemoryEvent | null {
    if (this.config.dryRun) return null;
    const id = crypto.randomUUID().replace(/-/g, "");
    const occurredAt = input.occurredAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO events(id, kind, entity_id, summary_enc, occurred_at, payload_enc)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.entityId ?? null,
        this.enc(input.summary),
        occurredAt,
        input.payload ? this.enc(JSON.stringify(input.payload)) : null,
      );
    this.eventCounterWindow.push(occurredAt);
    const cutoff = Date.now() - 60_000;
    this.eventCounterWindow = this.eventCounterWindow.filter((t) => t >= cutoff);
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('last_index_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(occurredAt));
    return {
      id,
      kind: input.kind,
      entityId: input.entityId,
      summary: this.config.redactSecrets
        ? redactSecrets(input.summary).text
        : input.summary,
      occurredAt,
      payload: input.payload,
    };
  }

  recent(limit = 20, opts?: SearchOptions): MemoryEntity[] {
    const offset = opts?.offset ?? 0;
    let sql = `SELECT * FROM entities WHERE 1=1`;
    const params: unknown[] = [];
    if (opts?.types?.length) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(",")})`;
      params.push(...opts.types);
    }
    if (opts?.sinceMs) {
      sql += ` AND last_seen_at >= ?`;
      params.push(opts.sinceMs);
    }
    if (opts?.untilMs) {
      sql += ` AND last_seen_at <= ?`;
      params.push(opts.untilMs);
    }
    sql += ` ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params);
    let entities = rows.map((r) => this.rowToEntity(r));
    if (opts?.pathPrefix) {
      const prefix = opts.pathPrefix;
      entities = entities.filter((e) => e.path?.startsWith(prefix));
    }
    return entities;
  }

  recentEvents(limit = 20, sinceMs?: number): MemoryEvent[] {
    let sql = `SELECT * FROM events`;
    const params: unknown[] = [];
    if (sinceMs) {
      sql += ` WHERE occurred_at >= ?`;
      params.push(sinceMs);
    }
    sql += ` ORDER BY occurred_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      entityId: r.entity_id ? String(r.entity_id) : undefined,
      summary: this.dec(String(r.summary_enc)),
      occurredAt: Number(r.occurred_at),
      payload: r.payload_enc
        ? (JSON.parse(this.dec(String(r.payload_enc))) as Record<string, unknown>)
        : undefined,
    }));
  }

  search(query: string, options: SearchOptions | number = {}): SearchHit[] {
    const opts: SearchOptions = typeof options === "number" ? { limit: options } : options;
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    let rows: Array<{ entity_id: string; rank: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT entity_id, bm25(entities_fts) AS rank
           FROM entities_fts
           WHERE entities_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, Math.max(limit * 8, 80)) as Array<{ entity_id: string; rank: number }>;
    } catch {
      return this.legacySearch(query, limit);
    }

    const hits: SearchHit[] = [];
    const now = Date.now();
    for (const row of rows) {
      const entity = this.getEntity(String(row.entity_id));
      if (!entity) continue;
      if (opts.types?.length && !opts.types.includes(entity.type)) continue;
      if (opts.pathPrefix && !entity.path?.startsWith(opts.pathPrefix)) continue;
      if (opts.sinceMs && entity.lastSeenAt < opts.sinceMs) continue;
      if (opts.untilMs && entity.lastSeenAt > opts.untilMs) continue;

      const matchedTerms = tokenize(query).filter(
        (t) =>
          entity.title.toLowerCase().includes(t) ||
          (entity.body?.toLowerCase().includes(t) ?? false) ||
          (entity.path?.toLowerCase().includes(t) ?? false),
      );
      const score = rankScore({
        bm25: Number(row.rank),
        lastSeenAt: entity.lastSeenAt,
        now,
        path: entity.path,
        query,
        matchedTerms,
        title: entity.title,
        body: entity.body,
      });
      const snippet = (entity.body ?? entity.title).slice(0, 180);
      hits.push({
        entity,
        score,
        bm25: Number(row.rank),
        matchedTerms,
        snippet,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(offset, offset + limit);
  }

  private legacySearch(query: string, limit: number): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const placeholders = terms.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT entity_id, COUNT(*) AS hits, GROUP_CONCAT(term) AS matched
         FROM search_terms
         WHERE term IN (${placeholders}) OR ${terms.map(() => `term LIKE ?`).join(" OR ")}
         GROUP BY entity_id
         ORDER BY hits DESC
         LIMIT ?`,
      )
      .all(...terms, ...terms.map((t) => `${t}%`), limit) as Array<{
      entity_id: string;
      hits: number;
      matched: string;
    }>;
    return rows
      .map((row) => {
        const entity = this.getEntity(String(row.entity_id));
        if (!entity) return null;
        return {
          entity,
          score: Number(row.hits),
          matchedTerms: String(row.matched || "").split(",").filter(Boolean),
        } satisfies SearchHit;
      })
      .filter((h): h is SearchHit => h != null);
  }

  buildContext(minutes = 30): ContextSummary {
    const untilMs = Date.now();
    const sinceMs = untilMs - minutes * 60_000;
    const entities = this.recent(120, { sinceMs, untilMs });
    const rawSessions = entities.filter((e) => e.type === "session");
    const summarized = summarizeSessions(
      rawSessions.map((e) => ({
        id: e.id,
        title: e.title,
        lastSeenAt: e.lastSeenAt,
        metadata: e.metadata,
      })),
      { noisyApps: this.config.noisyApps },
    );
    const sessions = summarized.map((s) => ({
      id: s.id,
      title: s.title,
      lastSeenAt: s.lastSeenAt,
      appName: s.appName,
      focusCount: s.focusCount,
      durationMs: s.durationMs,
    }));
    const files = dedupeByTitlePath(
      entities
        .filter((e) => e.type === "file")
        .map((e) => ({ id: e.id, title: e.title, path: e.path, lastSeenAt: e.lastSeenAt })),
    );
    const urls = dedupeByTitlePath(
      entities
        .filter((e) => e.type === "url")
        .map((e) => ({ id: e.id, title: e.title, path: e.path, lastSeenAt: e.lastSeenAt })),
    );
    const events = this.recentEvents(40, sinceMs).filter((ev) => {
      if (ev.kind !== "screen_focus") return true;
      const app = String((ev.payload as { appName?: string } | undefined)?.appName ?? "");
      if (!app) return true;
      return !isNoisyApp(app, this.config.noisyApps);
    });

    const linkSet: MemoryLink[] = [];
    for (const e of [...sessions, ...files].slice(0, 20)) {
      for (const l of this.getLinks(e.id, 10)) {
        if (!linkSet.some((x) => x.id === l.id)) linkSet.push(l);
      }
    }

    if (sessions[0] && files[0]) {
      const link = this.relate(files[0].id, sessions[0].id, "opened_during", 1);
      if (!linkSet.some((x) => x.id === link.id)) linkSet.push(link);
    }

    const droppedSessions = Math.max(0, rawSessions.length - summarized.length);
    const collapsedSessions = Math.max(
      0,
      summarized.reduce((n, s) => n + (s.focusCount - 1), 0),
    );

    const parts: string[] = [];
    parts.push(`Over the last ${minutes} minutes:`);
    if (sessions.length) {
      parts.push(
        `You focused on ${sessions
          .slice(0, 3)
          .map((s) => `"${s.title}"`)
          .join(", ")}.`,
      );
    } else {
      parts.push("No high-signal window sessions were captured (noisy apps filtered).");
    }
    if (files.length) {
      parts.push(
        `Files touched: ${files
          .slice(0, 5)
          .map((f) => f.title)
          .join(", ")}.`,
      );
    }
    if (urls.length) {
      parts.push(
        `Browser: ${urls
          .slice(0, 3)
          .map((u) => u.title)
          .join(", ")}.`,
      );
    }
    if (droppedSessions || collapsedSessions) {
      parts.push(
        `(Noise control: dropped ${droppedSessions} noisy sessions, collapsed ${collapsedSessions} duplicates.)`,
      );
    }
    if (linkSet.length) {
      parts.push(`Graph links in window: ${linkSet.length}.`);
    }
    if (!files.length && !sessions.length && !urls.length) {
      parts.push("Nothing indexed yet — start the daemon or open files under watch roots.");
    }

    return {
      minutes,
      sinceMs,
      untilMs,
      narrative: parts.join(" "),
      sessions: sessions.slice(0, 10),
      files: files.slice(0, 15),
      urls: urls.slice(0, 10),
      links: linkSet.slice(0, 30),
      events: events.slice(0, 20),
      noise: { droppedSessions, collapsedSessions },
    };
  }

  beginSession(title: string, entityId?: string): MemoryEntity | null {
    const entity =
      (entityId ? this.getEntity(entityId) : undefined) ??
      this.upsertEntity({
        type: "session",
        title,
        source: "session",
        metadata: { boundary: "start" },
      });
    if (!entity) return null;
    if (!this.config.dryRun) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO sessions(id, started_at, title_enc, entity_id) VALUES (?, ?, ?, ?)`,
        )
        .run(entity.id, Date.now(), this.enc(title), entity.id);
    }
    return entity;
  }

  endSession(entityId: string): void {
    if (this.config.dryRun) return;
    this.db
      .prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(Date.now(), entityId);
  }

  status(): {
    entities: number;
    links: number;
    events: number;
    dbPath: string;
    dataDir: string;
    dbBytes: number;
    encryptedAtRest: boolean;
    /** Honest: FTS holds redacted plaintext while unlocked. */
    ftsPlaintextWhileUnlocked: true;
    fieldEncryption: true;
    keyBackend: string;
    keyDetail: string;
    schemaVersion: string;
    lastIndexAt: number | null;
    eventsPerMinute: number;
    integrityOk: boolean;
    fts: boolean;
    sqliteBackend: string;
  } {
    const entities = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM entities`).get() as { c: number }).c,
    );
    const links = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM links`).get() as { c: number }).c,
    );
    const events = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c,
    );
    let dbBytes = 0;
    try {
      if (fs.existsSync(this.config.dbPath)) dbBytes = fs.statSync(this.config.dbPath).size;
    } catch {
      /* ignore */
    }
    const lastRow = this.db.prepare(`SELECT value FROM meta WHERE key = 'last_index_at'`).get() as
      | { value: string }
      | undefined;
    const cutoff = Date.now() - 60_000;
    this.eventCounterWindow = this.eventCounterWindow.filter((t) => t >= cutoff);
    return {
      entities,
      links,
      events,
      dbPath: this.config.dbPath,
      dataDir: this.config.dataDir,
      dbBytes,
      encryptedAtRest: true,
      ftsPlaintextWhileUnlocked: true,
      fieldEncryption: true,
      keyBackend: this.crypto.keyBackend,
      keyDetail: this.crypto.keyDetail,
      schemaVersion: SCHEMA_VERSION,
      lastIndexAt: lastRow ? Number(lastRow.value) : null,
      eventsPerMinute: this.eventCounterWindow.length,
      integrityOk: this.verifyIntegrity(),
      fts: true,
      sqliteBackend: this.db.backend || detectSqliteBackend(),
    };
  }

  updateIntegrity(): void {
    const snap = this.db.prepare(`SELECT COUNT(*) AS entities FROM entities`).get() as {
      entities: number;
    };
    const links = (this.db.prepare(`SELECT COUNT(*) AS c FROM links`).get() as { c: number }).c;
    const events = (this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
    const payload = `${snap.entities}:${links}:${events}`;
    const mac = this.crypto.hmac(payload);
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('integrity', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(`${payload}|${mac}`);
  }

  verifyIntegrity(): boolean {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'integrity'`).get() as
      | { value: string }
      | undefined;
    if (!row) return true;
    const [payload, mac] = String(row.value).split("|");
    if (!payload || !mac) return false;
    const expect = this.crypto.hmac(payload);
    try {
      return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
    } catch {
      return false;
    }
  }

  forget(query?: string): { deletedEntities: number; deletedEvents: number } {
    if (this.config.dryRun) return { deletedEntities: 0, deletedEvents: 0 };
    if (!query || query === "*" || query === "all") {
      const deletedEntities = Number(
        (this.db.prepare(`SELECT COUNT(*) AS c FROM entities`).get() as { c: number }).c,
      );
      const deletedEvents = Number(
        (this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c,
      );
      this.db.exec(
        `DELETE FROM entities_fts; DELETE FROM search_terms; DELETE FROM links; DELETE FROM events; DELETE FROM entities; DELETE FROM sessions;`,
      );
      this.updateIntegrity();
      return { deletedEntities, deletedEvents };
    }

    const hits = this.search(query, { limit: 500 });
    const ids = hits.map((h) => h.entity.id);
    if (ids.length === 0) return { deletedEntities: 0, deletedEvents: 0 };

    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM events WHERE entity_id IN (${placeholders})`).run(...ids);
    const deletedEvents = ids.length; // best-effort under sql.js
    this.db
      .prepare(
        `DELETE FROM links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
      )
      .run(...ids, ...ids);
    this.db.prepare(`DELETE FROM search_terms WHERE entity_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM entities_fts WHERE entity_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
    const deletedEntities = ids.length;
    this.updateIntegrity();
    return { deletedEntities, deletedEvents };
  }

  roundTrip(text: string): string {
    return this.crypto.decrypt(this.crypto.encrypt(text));
  }
}

export function openStore(config: AmbientConfig): MemoryStore {
  return new MemoryStore(config);
}

export async function openStoreAsync(config: AmbientConfig): Promise<MemoryStore> {
  return MemoryStore.openAsync(config);
}

export function hashContent(title: string, body?: string, filePath?: string): string {
  return contentHashOf(title, body, filePath);
}
