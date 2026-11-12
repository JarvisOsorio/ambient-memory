import type { AmbientDaemon } from "../indexer/daemon.js";
import type { EntityType, MemoryStore, SearchOptions } from "../store/memory-store.js";
import { APP_NAME, APP_VERSION } from "../config/defaults.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function err(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  const body = { error: { code, message, ...details } };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
    structuredContent: body,
  };
}

const entityTypeEnum = ["file", "session", "snippet", "url", "event"] as const;

export const MCP_TOOLS = [
  {
    name: "memory_search",
    description:
      "Full-text search over encrypted local ambient memory (FTS5/BM25 + recency/path boosts). Filter by type, path prefix, and time range. Returns stable JSON with pagination.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, description: "Search query (natural language or keywords)" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        offset: { type: "integer", minimum: 0, default: 0 },
        types: {
          type: "array",
          items: { type: "string", enum: [...entityTypeEnum] },
          description: "Restrict to entity types",
        },
        pathPrefix: { type: "string", description: "Only entities whose path starts with this prefix" },
        sinceMs: { type: "integer", description: "Only entities last seen at/after this epoch ms" },
        untilMs: { type: "integer", description: "Only entities last seen at/before this epoch ms" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_recent",
    description: "List recently seen entities and ambient events with optional filters and pagination.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        offset: { type: "integer", minimum: 0, default: 0 },
        types: { type: "array", items: { type: "string", enum: [...entityTypeEnum] } },
        pathPrefix: { type: "string" },
        sinceMs: { type: "integer" },
        untilMs: { type: "integer" },
        includeEvents: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "memory_get",
    description: "Fetch a single memory entity by id, including links.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 8, description: "Entity id" },
        includeLinks: { type: "boolean", default: true },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_relate",
    description: "Create or update a typed relation between two entity ids (graph edge).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        relation: {
          type: "string",
          description: "e.g. related_to, opened_during, references, derived_from",
          default: "related_to",
        },
        weight: { type: "number", minimum: 0, default: 1 },
      },
      required: ["fromId", "toId", "relation"],
    },
  },
  {
    name: "memory_context",
    description:
      "Narrative 'what was I doing' summary for the last N minutes — sessions, files, urls, graph links.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        minutes: { type: "integer", minimum: 1, maximum: 24 * 60, default: 30 },
      },
    },
  },
  {
    name: "memory_status",
    description: "Health + privacy snapshot: store counts, integrity, key backend, daemon state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
] as const;

export const MCP_PROMPTS = [
  {
    name: "recall_recent_work",
    description: "Ask ambient memory what the user was just working on",
    arguments: [
      { name: "minutes", description: "Lookback window in minutes", required: false },
    ],
  },
  {
    name: "search_project_memory",
    description: "Search local ambient memory for a topic before answering",
    arguments: [{ name: "query", description: "What to look up", required: true }],
  },
] as const;

export function handleMemoryTool(
  store: MemoryStore,
  name: string,
  args: Record<string, unknown>,
  daemon?: AmbientDaemon,
): ToolResult {
  try {
    switch (name) {
      case "memory_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return err("invalid_argument", "query is required and must be non-empty");
        const limit = clampInt(args.limit, 10, 1, 100);
        const offset = clampInt(args.offset, 0, 0, 10_000);
        const options: SearchOptions = {
          limit,
          offset,
          types: parseTypes(args.types),
          pathPrefix: args.pathPrefix != null ? String(args.pathPrefix) : undefined,
          sinceMs: args.sinceMs != null ? Number(args.sinceMs) : undefined,
          untilMs: args.untilMs != null ? Number(args.untilMs) : undefined,
        };
        const started = Date.now();
        const hits = store.search(query, options).map((h) => ({
          id: h.entity.id,
          type: h.entity.type,
          title: h.entity.title,
          path: h.entity.path,
          score: Number(h.score.toFixed(4)),
          bm25: h.bm25,
          matchedTerms: h.matchedTerms,
          snippet: h.snippet,
          lastSeenAt: h.entity.lastSeenAt,
          source: h.entity.source,
        }));
        return ok({
          ok: true,
          query,
          count: hits.length,
          limit,
          offset,
          latencyMs: Date.now() - started,
          hits,
        });
      }
      case "memory_recent": {
        const limit = clampInt(args.limit, 10, 1, 100);
        const offset = clampInt(args.offset, 0, 0, 10_000);
        const includeEvents = args.includeEvents !== false;
        const options: SearchOptions = {
          offset,
          types: parseTypes(args.types),
          pathPrefix: args.pathPrefix != null ? String(args.pathPrefix) : undefined,
          sinceMs: args.sinceMs != null ? Number(args.sinceMs) : undefined,
          untilMs: args.untilMs != null ? Number(args.untilMs) : undefined,
        };
        const entities = store.recent(limit, options).map(serializeEntity);
        return ok({
          ok: true,
          count: entities.length,
          limit,
          offset,
          entities,
          events: includeEvents ? store.recentEvents(limit, options.sinceMs).map(serializeEvent) : [],
        });
      }
      case "memory_get": {
        const id = String(args.id ?? "");
        if (id.length < 8) return err("invalid_argument", "id must be at least 8 characters");
        const entity = store.getEntity(id);
        if (!entity) return err("not_found", `No entity with id ${id}`, { id });
        const includeLinks = args.includeLinks !== false;
        return ok({
          ok: true,
          entity: serializeEntity(entity),
          links: includeLinks ? store.getLinks(id) : [],
        });
      }
      case "memory_relate": {
        const fromId = String(args.fromId ?? "");
        const toId = String(args.toId ?? "");
        const relation = String(args.relation ?? "related_to");
        const weight = Number(args.weight ?? 1);
        if (!store.getEntity(fromId)) return err("not_found", "fromId does not exist", { fromId });
        if (!store.getEntity(toId)) return err("not_found", "toId does not exist", { toId });
        if (!relation.trim()) return err("invalid_argument", "relation is required");
        const link = store.relate(fromId, toId, relation, weight);
        return ok({ ok: true, link });
      }
      case "memory_context": {
        const minutes = clampInt(args.minutes, 30, 1, 24 * 60);
        const ctx = store.buildContext(minutes);
        return ok({ ok: true, ...ctx });
      }
      case "memory_status": {
        return ok({
          ok: true,
          app: APP_NAME,
          version: APP_VERSION,
          store: store.status(),
          daemon: daemon?.getStatus() ?? { running: false },
          privacy: {
            localOnly: true,
            telemetry: false,
            secretsRedacted: store.config.redactSecrets,
            encryptedFields: true,
            dbSealedOnStop: true,
            keyBackend: store.crypto.keyBackend,
          },
        });
      }
      default:
        return err("unknown_tool", `Unknown tool: ${name}`);
    }
  } catch (e) {
    return err("internal_error", e instanceof Error ? e.message : String(e));
  }
}

export function renderPrompt(
  store: MemoryStore,
  name: string,
  args: Record<string, string>,
): string {
  if (name === "recall_recent_work") {
    const minutes = Number(args.minutes ?? 30);
    const ctx = store.buildContext(minutes);
    return `Using ambient memory context below, summarize what the user was working on.\n\n${ctx.narrative}\n\nJSON:\n${JSON.stringify(ctx, null, 2)}`;
  }
  if (name === "search_project_memory") {
    const query = args.query ?? "";
    const hits = store.search(query, { limit: 8 });
    return `Search results for "${query}":\n${JSON.stringify(hits.map((h) => ({ title: h.entity.title, path: h.entity.path, score: h.score, snippet: h.snippet })), null, 2)}\nUse these to answer accurately; prefer file paths that exist locally.`;
  }
  return `Unknown prompt: ${name}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseTypes(value: unknown): EntityType[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map(String).filter((t): t is EntityType =>
    (entityTypeEnum as readonly string[]).includes(t),
  );
}

function serializeEntity(e: {
  id: string;
  type: string;
  title: string;
  body?: string;
  path?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  source: string;
  metadata: Record<string, unknown>;
}) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    path: e.path,
    bodyPreview: e.body?.slice(0, 240),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastSeenAt: e.lastSeenAt,
    source: e.source,
    metadata: e.metadata,
  };
}

function serializeEvent(e: {
  id: string;
  kind: string;
  entityId?: string;
  summary: string;
  occurredAt: number;
}) {
  return {
    id: e.id,
    kind: e.kind,
    entityId: e.entityId,
    summary: e.summary,
    occurredAt: e.occurredAt,
  };
}
