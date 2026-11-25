/**
 * 1Password SaaS Manager's AWS Marketplace Skill — MCP server.
 *
 * Exposes the tools in src/tools.ts over MCP so any MCP client can invoke them.
 * The same tools are also available from the shell via src/cli.ts, which is what
 * the portable SKILL.md (Claude Code + Codex) drives.
 *
 * Dependency-free stdio transport (newline-delimited JSON-RPC 2.0), mirroring the
 * project's dependency-free MCP CLIENT. Local-first: the user's data never leaves
 * their machine. Remote-ready: the tool handlers are transport-agnostic, so the
 * same set can later be served over HTTP without change.
 *
 * Tools take a `provider` arg (registry id); this bundle's registry has only
 * the 1Password SaaS Manager provider.
 *
 * Run:  node --env-file=.env --import tsx src/mcpServer.ts
 */

import { createInterface } from "node:readline";
import { SAAS_ADAPTERS } from "./saasAdapters.js";
import { TOOLS, SERVER_INSTRUCTIONS, validateArgs } from "./tools.js";
import { VERSION } from "./version.js";
import { DATA_NOTICE, forAgent, safeErrorMessage } from "./untrusted.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "consolidation-agent", version: VERSION };

// ── JSON-RPC stdio loop ─────────────────────────────────────────────────────────
function send(msg: unknown) { process.stdout.write(JSON.stringify(msg) + "\n"); }
const ok = (id: any, result: unknown) => send({ jsonrpc: "2.0", id, result });
const err = (id: any, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return; // no response
  if (method === "tools/list") {
    return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return err(id, -32602, `Unknown tool: ${params?.name}`);
    // Same input contract as the CLI: known arguments only, required ones present, every value of its declared type.
    const args = params.arguments ?? {};
    const problems = validateArgs(tool, args);
    if (problems.length) return ok(id, { content: [{ type: "text", text: `Error: invalid arguments: ${problems.join("; ")}` }], isError: true });
    try {
      const result = forAgent(await tool.handler(args));
      return ok(id, { content: [{ type: "text", text: DATA_NOTICE }, { type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e: any) {
      return ok(id, { content: [{ type: "text", text: `Error: ${safeErrorMessage(e)}` }], isError: true });
    }
  }
  if (id !== undefined) return err(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg: any;
  try { msg = JSON.parse(s); } catch { return; }
  Promise.resolve(handle(msg)).catch((e) => { if (msg?.id !== undefined) err(msg.id, -32603, safeErrorMessage(e)); });
});
process.stderr.write(`consolidation-agent MCP server ready (providers: ${Object.keys(SAAS_ADAPTERS).join(", ")})\n`);
