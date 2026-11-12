/**
 * Demo: seed sample activity and prove search / recent / MCP tools work.
 * Usage: npm run demo
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../src/config/defaults.js";
import { AmbientDaemon } from "../src/indexer/daemon.js";
import { createMcpHandlers } from "../src/mcp/server.js";

async function main(): Promise<void> {
  const demoRoot = path.join(os.tmpdir(), `ambient-demo-${Date.now()}`);
  const workspace = path.join(demoRoot, "workspace");
  const dataDir = path.join(demoRoot, "data");
  fs.mkdirSync(workspace, { recursive: true });

  console.log("=== Ambient Memory demo ===");
  console.log(`workspace: ${workspace}`);
  console.log(`dataDir:   ${dataDir}`);

  // Seed files that look like real founder activity
  fs.writeFileSync(
    path.join(workspace, "pitch.md"),
    `# Pitch\nZero-config ambient memory for solo founders.\nBeat GBrain setup friction.\n`,
  );
  fs.writeFileSync(
    path.join(workspace, "mcp-integration.ts"),
    `// Wire memory_search into Cursor\nexport const tools = ["memory_search","memory_recent"];\n`,
  );
  fs.writeFileSync(
    path.join(workspace, "secrets-example.txt"),
    `Do not store this: sk-abcdefghijklmnopqrstuvwxyz123456\n`,
  );

  const config = buildConfig({
    dataDir,
    watchRoots: [workspace],
    screenProvider: "simulated",
    screenIntervalMs: 100,
    browserEnabled: true,
    forceFileKey: true,
  });

  const daemon = new AmbientDaemon(config);
  await daemon.start();
  console.log(`\nDaemon up (screen=${daemon.getStatus().screenProvider})`);

  // Mutate a file to generate a modify event
  await new Promise((r) => setTimeout(r, 500));
  fs.appendFileSync(path.join(workspace, "pitch.md"), "\nDemo append: shipping tonight.\n");
  await new Promise((r) => setTimeout(r, 700));

  // Manual snippet + relation for the graph story
  const snippet = daemon.store.upsertEntity({
    type: "snippet",
    title: "founder note",
    body: "Need MCP tools so Cursor can recall my last session without Markdown vaults.",
    source: "demo",
  });
  const files = daemon.store.search("pitch");
  if (snippet && files[0]) {
    daemon.store.relate(snippet.id, files[0].entity.id, "references");
  }

  const mcp = createMcpHandlers(daemon.store);

  console.log("\n--- ambient search \"founders MCP\" ---");
  const search = mcp.callTool("memory_search", { query: "founders MCP", limit: 5 });
  console.log(search.content[0]?.text);

  console.log("\n--- ambient recent ---");
  const recent = mcp.callTool("memory_recent", { limit: 5 });
  console.log(recent.content[0]?.text);

  console.log("\n--- memory_context ---");
  const context = mcp.callTool("memory_context", { minutes: 30 });
  console.log(context.content[0]?.text);

  console.log("\n--- memory_get ---");
  const recentId = daemon.store.recent(1)[0]?.id;
  if (recentId) {
    console.log(mcp.callTool("memory_get", { id: recentId }).content[0]?.text);
  }

  console.log("\n--- memory_status ---");
  const status = mcp.callTool("memory_status", {});
  console.log(status.content[0]?.text);

  console.log("\n--- secret redaction check ---");
  const secretHits = daemon.store.search("REDACTED");
  const leaked = daemon.store.search("sk-abcdefgh");
  console.log(
    JSON.stringify(
      {
        redactionMarkersFound: secretHits.length,
        rawKeySearchHits: leaked.length,
        sample: secretHits[0]?.entity.body?.slice(0, 120),
      },
      null,
      2,
    ),
  );

  console.log("\n--- browser hook ---");
  console.log(JSON.stringify(daemon.browserNote, null, 2));

  await daemon.stop(true);
  console.log(`\nSealed store: ${config.dbPath}.enc`);
  console.log("Demo complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
