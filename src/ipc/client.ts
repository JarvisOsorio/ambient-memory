import net from "node:net";
import { randomUUID } from "node:crypto";
import type { AmbientConfig } from "../config/defaults.js";
import { ipcEndpoint } from "./paths.js";
import {
  IPC_PROTOCOL_VERSION,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";

export class IpcClient {
  private socket: net.Socket;
  private buf = "";
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly endpoint: string;

  private constructor(socket: net.Socket, endpoint: string) {
    this.socket = socket;
    this.endpoint = endpoint;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(String(chunk)));
    socket.on("error", (err) => this.failAll(err));
    socket.on("close", () => this.failAll(new Error("IPC connection closed")));
  }

  static connect(config: AmbientConfig, timeoutMs = 2000): Promise<IpcClient> {
    const endpoint = ipcEndpoint(config);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ambient daemon at ${endpoint}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new IpcClient(socket, endpoint));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  static async tryConnect(config: AmbientConfig, timeoutMs = 500): Promise<IpcClient | null> {
    try {
      return await IpcClient.connect(config, timeoutMs);
    } catch {
      return null;
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let res: RpcResponse;
      try {
        res = JSON.parse(line) as RpcResponse;
      } catch {
        continue;
      }
      const pending = this.pending.get(res.id);
      if (!pending) continue;
      this.pending.delete(res.id);
      if (res.ok) pending.resolve(res.result);
      else pending.reject(new Error(`${res.error.code}: ${res.error.message}`));
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  call<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
    const id = randomUUID();
    const req: RpcRequest = { v: IPC_PROTOCOL_VERSION, id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.socket.write(`${JSON.stringify(req)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}
