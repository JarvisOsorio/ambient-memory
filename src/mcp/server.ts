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
import { MemoryStore } from "../store/memory-store.js";
import { handleMemoryTool, MCP_PROMPTS, MCP_TOOLS, renderPrompt } from "./tools.js";

export async function startMcpServer(config: AmbientConfig): Promise<void> {
  const store = await MemoryStore.openAsync(config);

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
    const result = handleMemoryTool(store, request.params.name, args);
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
    if (uri === "ambient://status") {
      const body = handleMemoryTool(store, "memory_status", {});
      return {
        contents: [{ uri, mimeType: "application/json", text: body.content[0]!.text }],
      };
    }
    if (uri === "ambient://recent") {
      const body = handleMemoryTool(store, "memory_recent", { limit: 15 });
      return {
        contents: [{ uri, mimeType: "application/json", text: body.content[0]!.text }],
      };
    }
    if (uri === "ambient://context") {
      const body = handleMemoryTool(store, "memory_context", { minutes: 30 });
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
    const text = renderPrompt(store, request.params.name, args);
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
    // MCP is a one-shot process relative to the vault — seal on exit.
    store.close(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

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
