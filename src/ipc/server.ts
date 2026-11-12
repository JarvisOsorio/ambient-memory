import fs from "node:fs";
import net from "node:net";
import type { AmbientConfig } from "../config/defaults.js";
import type { AmbientDaemon } from "../indexer/daemon.js";
import type { MemoryStore } from "../store/memory-store.js";
import { ipcEndpoint } from "./paths.js";
import {
  IPC_PROTOCOL_VERSION,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";

export interface IpcServerHandle {
  endpoint: string;
  close(): Promise<void>;
}

function respond(id: string, result: unknown): RpcSuccess {
  return { v: IPC_PROTOCOL_VERSION, id, ok: true, result };
}

function fail(id: string, code: string, message: string): RpcFailure {
  return { v: IPC_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

type RpcSuccess = Extract<RpcResponse, { ok: true }>;
type RpcFailure = Extract<RpcResponse, { ok: false }>;

export function handleRpc(
  store: MemoryStore,
  daemon: AmbientDaemon | undefined,
  method: RpcMethod,
  params: Record<string, unknown> = {},
): unknown {
  switch (method) {
    case "ping":
      return { pong: true, pid: process.pid };
    case "search": {
      const query = String(params.query ?? "");
      return store.search(query, {
        limit: params.limit != null ? Number(params.limit) : undefined,
        offset: params.offset != null ? Number(params.offset) : undefined,
        types: Array.isArray(params.types) ? (params.types as never) : undefined,
        pathPrefix: params.pathPrefix != null ? String(params.pathPrefix) : undefined,
        sinceMs: params.sinceMs != null ? Number(params.sinceMs) : undefined,
        untilMs: params.untilMs != null ? Number(params.untilMs) : undefined,
      });
    }
    case "recent":
      return store.recent(params.limit != null ? Number(params.limit) : 20, {
        offset: params.offset != null ? Number(params.offset) : undefined,
        types: Array.isArray(params.types) ? (params.types as never) : undefined,
        pathPrefix: params.pathPrefix != null ? String(params.pathPrefix) : undefined,
        sinceMs: params.sinceMs != null ? Number(params.sinceMs) : undefined,
        untilMs: params.untilMs != null ? Number(params.untilMs) : undefined,
      });
    case "recentEvents":
      return store.recentEvents(
        params.limit != null ? Number(params.limit) : 20,
        params.sinceMs != null ? Number(params.sinceMs) : undefined,
      );
    case "getEntity": {
      const id = String(params.id ?? "");
      return store.getEntity(id) ?? null;
    }
    case "getLinks":
      return store.getLinks(
        String(params.entityId ?? ""),
        params.limit != null ? Number(params.limit) : 100,
      );
    case "context":
      return store.buildContext(params.minutes != null ? Number(params.minutes) : 30);
    case "relate":
      return store.relate(
        String(params.fromId ?? ""),
        String(params.toId ?? ""),
        String(params.relation ?? "related_to"),
        params.weight != null ? Number(params.weight) : 1,
      );
    case "status": {
      const storeStatus = store.status();
      return {
        store: storeStatus,
        daemon: daemon?.getStatus() ?? { running: true, pid: process.pid },
        ipc: { endpoint: daemon ? ipcEndpoint(daemon.config) : null },
      };
    }
    case "forget":
      return store.forget(params.query != null ? String(params.query) : "*");
    case "doctor":
      return {
        store: store.status(),
        daemon: daemon?.getStatus() ?? null,
        sqliteBackend: store.db.backend,
      };
    case "meta": {
      const key = String(params.key ?? "");
      const row = store.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export async function startIpcServer(
  config: AmbientConfig,
  store: MemoryStore,
  daemon?: AmbientDaemon,
): Promise<IpcServerHandle> {
  const endpoint = ipcEndpoint(config);

  if (process.platform !== "win32") {
    try {
      if (fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
    } catch {
      /* ignore */
    }
  }

  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req: RpcRequest;
        try {
          req = JSON.parse(line) as RpcRequest;
        } catch {
          socket.write(
            `${JSON.stringify(fail("unknown", "invalid_json", "Request was not valid JSON"))}\n`,
          );
          continue;
        }
        let response: RpcResponse;
        try {
          const result = handleRpc(store, daemon, req.method, req.params ?? {});
          response = respond(req.id, result);
        } catch (err) {
          response = fail(
            req.id,
            "rpc_error",
            err instanceof Error ? err.message : String(err),
          );
        }
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(endpoint, 0o600);
    } catch {
      /* ignore */
    }
  }

  return {
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (process.platform !== "win32") {
            try {
              if (fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
            } catch {
              /* ignore */
            }
          }
          resolve();
        });
      }),
  };
}
