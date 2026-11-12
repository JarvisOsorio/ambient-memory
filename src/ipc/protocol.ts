import type {
  ContextSummary,
  EntityType,
  MemoryEntity,
  MemoryEvent,
  MemoryLink,
  SearchHit,
  SearchOptions,
} from "../store/memory-store.js";

export const IPC_PROTOCOL_VERSION = 1;

export type RpcMethod =
  | "ping"
  | "search"
  | "recent"
  | "recentEvents"
  | "getEntity"
  | "getLinks"
  | "context"
  | "relate"
  | "status"
  | "forget"
  | "doctor"
  | "meta";

export interface RpcRequest {
  v: typeof IPC_PROTOCOL_VERSION;
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export interface RpcSuccess {
  v: typeof IPC_PROTOCOL_VERSION;
  id: string;
  ok: true;
  result: unknown;
}

export interface RpcFailure {
  v: typeof IPC_PROTOCOL_VERSION;
  id: string;
  ok: false;
  error: { code: string; message: string };
}

export type RpcResponse = RpcSuccess | RpcFailure;

export interface SearchParams extends SearchOptions {
  query: string;
}

export interface SerializedSearchHit {
  entity: MemoryEntity;
  score: number;
  bm25?: number;
  matchedTerms: string[];
  snippet?: string;
}

export type {
  ContextSummary,
  EntityType,
  MemoryEntity,
  MemoryEvent,
  MemoryLink,
  SearchHit,
  SearchOptions,
};
