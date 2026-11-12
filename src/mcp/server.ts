import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AmbientConfig } from "../config/defaults.js";
import { APP_NAME, APP_VERSION } from "../config/defaults.js";
import type { IpcClient } from "../ipc/client.js";
import type { MemoryStore } from "../store/memory-store.js";
import {
  handleMemoryTool,
  handleMemoryToolRemote,
  MCP_PROMPTS,
  MCP_TOOLS,
  renderPrompt,
  renderPromptRemote,
} from "./tools.js";

export async function startMcpServer(
  config: AmbientConfig,
  opts: { autoStart?: boolean } = {},
): Promise<void> {
  // Keep a long-lived IPC connection for the life of the MCP stdio session.
  const autoStart = opts.autoStart !== false;
  let client: IpcClient | null = null;

  const getClient = async (): Promise<IpcClient> => {
    if (client) return client;
    const { IpcClient: IC } = await import("../ipc/client.js");
    if (autoStart) {
      const { ensureDaemonRunning } = await import("../indexer/ensure-daemon.js");
      await ensureDaemonRunning(config);
    }
    client = await IC.connect(config, 3000);
    return client;
  };

  // Prime connection early so MCP tools fail fast with a clear error
  await getClient();

  const server = new Server(
    { name: APP_NAME, version: APP_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const c = await getClient();
    const result = await handleMemoryToolRemote(c, request.params.name, args);
    return {
      content: result.content,
      isError: result.isError,
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "ambient://status",
        name: "Ambient status",
        description: "Live store/daemon health JSON",
        mimeType: "application/json",
      },
      {
        uri: "ambient://recent",
        name: "Recent memory",
        description: "Most recently seen entities",
        mimeType: "application/json",
      },
      {
        uri: "ambient://context",
        name: "Recent context narrative",
        description: "What you were doing (last 30 minutes)",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const c = await getClient();
    if (uri === "ambient://status") {
      const body = await handleMemoryToolRemote(c, "memory_status", {});
      return {
        contents: [{ uri, mimeType: "application/json", text: body.content[0]!.text }],
      };
    }
    if (uri === "ambient://recent") {
      const body = await handleMemoryToolRemote(c, "memory_recent", { limit: 15 });
      return {
        contents: [{ uri, mimeType: "application/json", text: body.content[0]!.text }],
      };
    }
    if (uri === "ambient://context") {
      const body = await handleMemoryToolRemote(c, "memory_context", { minutes: 30 });
      return {
        contents: [{ uri, mimeType: "application/json", text: body.content[0]!.text }],
      };
    }
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `Unknown resource: ${uri}`,
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.params.arguments ?? {})) {
      args[k] = String(v);
    }
    const c = await getClient();
    const text = await renderPromptRemote(c, request.params.name, args);
    return {
      description: request.params.name,
      messages: [
        {
          role: "user",
          content: { type: "text", text },
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    try {
      client?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** In-process handlers for tests that already hold a MemoryStore. */
export function createMcpHandlers(store: MemoryStore) {
  return {
    listTools: () => MCP_TOOLS,
    listPrompts: () => MCP_PROMPTS,
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      handleMemoryTool(store, name, args),
    renderPrompt: (name: string, args: Record<string, string> = {}) =>
      renderPrompt(store, name, args),
  };
}
