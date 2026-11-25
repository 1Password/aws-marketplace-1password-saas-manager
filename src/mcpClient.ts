/**
 * Minimal MCP client over Streamable HTTP (JSON-RPC 2.0) — enough to drive the
 * remote MCP servers from Node (a SaaS-management source, AWS Marketplace): initialize → capture
 * the session id → `notifications/initialized` → `tools/call`.
 *
 * Handles both response encodings these servers use: plain `application/json`
 * and `text/event-stream` (SSE `data:` lines). No SDK dependency (keeps the bundle
 * dependency-free); this is the connection-layer piece the agent needs.
 */

import { VERSION } from "./version.js";
import { checkedUrl } from "./egress.js";
import { basename } from "node:path";
import { normalizeToolResult, writeMcpHealth, MCP_TOOLS } from "./mcpShapes.js";
import { mcpHealthPath } from "./paths.js";

// Record what this process's Marketplace MCP responses looked like (mcpShapes.ts), once, at exit.
const PIPELINE_STEPS = new Set(["ingestMatch", "enrichActions", "enrichDeployment", "enrichShadowIt", "enrichComparisons"]);
let healthHooked = false;
function hookHealth() {
  if (healthHooked) return;
  healthHooked = true;
  const step = basename(process.argv[1] ?? "unknown").replace(/\.[jt]s$/, "");
  // Only the pipeline's own steps feed the run's health log; setup probes and check-mcp don't.
  if (!PIPELINE_STEPS.has(step)) return;
  process.on("exit", () => {
    try { writeMcpHealth(mcpHealthPath(), step); } catch { /* never fail a run over the health log */ }
  });
}

export interface McpClientOptions {
  url: string;
  /** Full Authorization header value, e.g. "Bearer <token>". Omit for no-auth. */
  authorization?: string;
  clientName?: string;
  protocolVersion?: string;
}

export class McpClient {
  private url: string;
  private authorization?: string;
  private clientName: string;
  private protocolVersion: string;
  private sessionId?: string;
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = checkedUrl(opts.url);
    this.authorization = opts.authorization;
    this.clientName = opts.clientName ?? "consolidation-agent";
    this.protocolVersion = opts.protocolVersion ?? "2025-06-18";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    if (this.authorization) h["Authorization"] = this.authorization;
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  /** Parse a fetch Response that may be JSON or an SSE stream into a JSON-RPC object. */
  private async parse(res: Response): Promise<any> {
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream") || /^\s*event:|^\s*data:/m.test(text)) {
      // Take the last `data:` payload that parses as JSON-RPC.
      const dataLines = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      for (let i = dataLines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(dataLines[i]);
        } catch {
          /* keep scanning */
        }
      }
      throw new Error("The AWS Marketplace MCP sent a response with no JSON payload.");
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("The AWS Marketplace MCP sent a response that isn't valid JSON.");
    }
  }

  /** Perform the initialize handshake and capture the session id. */
  async connect(): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: this.clientName, version: VERSION },
        },
      }),
    });
    // Response bodies are never passed on: only the status.
    if (!res.ok) throw new Error(`Connecting to the AWS Marketplace MCP failed (HTTP ${res.status}).`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    await this.parse(res); // drain/validate

    // Best-effort initialized notification (some servers require it before tools).
    await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    }).catch(() => {});
  }

  /**
   * Call a tool. Returns the parsed result: `structuredContent` if present,
   * else the first text content JSON-parsed, else the raw text/result.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, retries = 6): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });

      if (res.status === 429) {
        if (attempt < retries) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`tools/call ${name}: throttled (HTTP 429) after ${retries} retries`);
      }
      if (!res.ok) throw new Error(`AWS Marketplace MCP ${name} failed (HTTP ${res.status}).`);

      const rpc = await this.parse(res);
      if (rpc.error) throw new Error(`AWS Marketplace MCP ${name} failed (error code ${Number(rpc.error?.code) || "unknown"}).`);
      const result = rpc.result ?? {};
      if (result.isError) {
        const t = (result.content ?? []).map((c: any) => c.text).join("; ");
        // Tool-level throttling comes back as isError text, not HTTP 429 — retry it too.
        if (/throttl|rate.?limit|429/i.test(t) && attempt < retries) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`AWS Marketplace MCP ${name} returned an error.`);
      }
      // AWS Marketplace tools: check the shape and drop or clean what doesn't fit (mcpShapes.ts).
      if ((MCP_TOOLS as readonly string[]).includes(name)) {
        hookHealth();
        return normalizeToolResult(name, McpClient.payload(result));
      }
      return McpClient.payload(result);
    }
  }

  /** The tool's result: `structuredContent` if present, else the first text content JSON-parsed. */
  private static payload(result: any): any {
    if (result.structuredContent !== undefined) return result.structuredContent;
    for (const c of result.content ?? []) {
      if (c.type === "text") {
        try {
          return JSON.parse(c.text);
        } catch {
          return c.text;
        }
      }
    }
    return result;
  }

  /** Exponential backoff with jitter: ~0.5s, 1s, 2s, 4s, … capped at 15s. */
  private backoff(attempt: number): Promise<void> {
    const ms = Math.min(15000, 500 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    return new Promise((r) => setTimeout(r, ms));
  }
}
