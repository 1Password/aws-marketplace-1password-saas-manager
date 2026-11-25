/**
 * Connectivity probes — one per source. Each returns a SourceStatus.
 *
 * One cheap, read-only check per source:
 *   - Discovery API:  one SearchListings call (AWS SDK)
 *   - Agreements API: one SearchAgreements call (AWS SDK, the user's own profile)
 *   - Marketplace MCP + SaaS-source MCP: HTTP reachability of the MCP endpoint.
 *
 * The SaaS-source probe is vendor-neutral: it reads endpoint/token/auth from
 * the active adapter (the registered SaaS-management source), so no probe code
 * changes when the provider is swapped.
 *
 * Design note: probes are deliberately cheap and read-only. The point is
 * "can we reach it and get a well-formed response", not to pull real insight
 * data; the pipeline does that.
 */

import { SearchListingsCommand } from "@aws-sdk/client-marketplace-discovery";
import type { SourceStatus, SourceRole } from "./types.js";
import { activeSaaSProvider } from "./saasAdapters.js";
import { discoveryAuth, configuredProfile } from "./discoveryAuth.js";
import { McpClient } from "./mcpClient.js";
import { shapeSummary } from "./mcpShapes.js";
import { VERSION } from "./version.js";
import { searchRealAgreements } from "./agreements.js";
import { awsErrorText } from "./awsClients.js";

const MARKETPLACE_MCP_URL =
  process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";

/**
 * Probe the Discovery API with the customer's own AWS profile (one small search). Optional: with no
 * profile, or one that fails, matching uses the AWS Marketplace MCP instead (catalog.ts).
 */
export async function probeDiscoveryApi(): Promise<SourceStatus> {
  const profile = configuredProfile();
  if (!profile) {
    return {
      role: "discovery-api",
      connected: false,
      detail: "Optional, recommended: no AWS profile is set (AWS_PROFILE in .env), so matching uses the public AWS Marketplace MCP. A read-only AWS Marketplace profile from your own AWS account gives more complete matching (README step 5).",
    };
  }
  try {
    const auth = discoveryAuth();
    const parsed = await auth.client.send(new SearchListingsCommand({ searchText: "monitoring", maxResults: 1 }));
    return { role: "discovery-api", connected: true, sample: { listingCount: (parsed.listingSummaries ?? []).length, via: auth.describe } };
  } catch (err) {
    return { role: "discovery-api", connected: false, detail: `${awsErrorText(err, `AWS profile "${profile}"`)} Until this is fixed, matching uses the AWS Marketplace MCP.` };
  }
}

/** Probe the Agreements API (AWS SDK, the user's own profile). Buyer = Acceptor party type. */
export async function probeAgreementsApi(): Promise<SourceStatus> {
  if (!configuredProfile()) {
    return { role: "agreements-api", connected: false, detail: "Optional: no AWS profile is set (AWS_PROFILE in .env). With a read-only AWS profile, the dashboard finds what you already buy on AWS Marketplace." };
  }
  try {
    const summaries = await searchRealAgreements(1);
    // An empty list is a VALID connected result (an account with no Marketplace purchases).
    return { role: "agreements-api", connected: true, sample: { agreementCount: summaries.length } };
  } catch (err) {
    return { role: "agreements-api", connected: false, detail: awsErrorHint(err) };
  }
}

/** Probe an MCP endpoint by checking HTTP reachability of its URL. */
async function probeMcpEndpoint(
  role: SourceRole,
  url: string,
  authHeader?: string,
  extra?: Partial<SourceStatus>,
): Promise<SourceStatus> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    };
    if (authHeader) headers["Authorization"] = authHeader;

    // A minimal JSON-RPC initialize ping — enough to prove the pipe + auth.
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "consolidation-agent-probe", version: VERSION },
        },
      }),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        role,
        connected: false,
        detail: `Auth rejected (HTTP ${res.status}). Check the token / role for ${url}.`,
        ...extra,
      };
    }
    if (!res.ok) {
      return { role, connected: false, detail: `HTTP ${res.status} from ${url}.`, ...extra };
    }
    return { role, connected: true, sample: { httpStatus: res.status }, ...extra };
  } catch (err) {
    return {
      role,
      connected: false,
      detail: `Could not reach ${url} (network error). Check your internet connection and retry.`,
      ...extra,
    };
  }
}

/**
 * Probe the AWS Marketplace MCP: reachable, and do its responses still have the shape the bundle
 * expects? One fixed search, checked by mcpShapes.ts (via McpClient). No auth required.
 */
export async function probeMarketplaceMcp(): Promise<SourceStatus> {
  const reach = await probeMcpEndpoint("marketplace-mcp", MARKETPLACE_MCP_URL);
  if (!reach.connected) return reach;
  try {
    const c = new McpClient({ url: MARKETPLACE_MCP_URL, clientName: "consolidation-agent-probe" });
    await c.connect();
    const r = await c.callTool("search_aws_marketplace_solutions", { queries: ["monitoring"], max_results: 3 });
    const issues = shapeSummary().issues;
    if (!(r?.results ?? []).length || issues.length) {
      return {
        ...reach,
        detail: `Connected, but its responses have changed: ${issues.length ? issues.slice(0, 3).map((i) => i.problem).join("; ") : "a test search returned no listings"}. The dashboard leaves out or blanks the affected details and says so; run npm run check-mcp for the full check.`,
      };
    }
    return reach;
  } catch {
    return { ...reach, detail: "Connected, but a test search failed. Matching without an AWS profile may not work; run npm run check-mcp." };
  }
}

/**
 * Probe the pluggable SaaS-management source. Vendor-neutral: endpoint, token
 * env var, and auth scheme all come from the active adapter.
 */
export async function probeSaaSSource(): Promise<SourceStatus> {
  const saas = activeSaaSProvider();

  // A provider whose real connection isn't a remote bearer MCP (e.g. a local stdio
  // bridge) supplies its own check — use it so onboarding reports the ACTUAL
  // connection, not an HTTP endpoint the buyer never uses.
  if (saas.probeConnection) {
    const r = await saas.probeConnection();
    return { role: "saas-source", provider: saas.id, connected: r.connected, detail: r.connected ? undefined : r.detail };
  }

  const url = process.env[saas.endpointEnvVar] ?? saas.defaultEndpoint;

  let authHeader: string | undefined;
  if (saas.authScheme === "bearer") {
    const token = saas.tokenEnvVar ? process.env[saas.tokenEnvVar] : undefined;
    if (!token) {
      return Promise.resolve({
        role: "saas-source",
        provider: saas.id,
        connected: false,
        detail:
          `${saas.tokenEnvVar} not set. Export it to probe ${saas.label}. ` +
          "(A live MCP connection in Claude Code uses the same key via its header config.)",
      });
    }
    authHeader = `Bearer ${token}`;
  }

  return probeMcpEndpoint("saas-source", url, authHeader, { provider: saas.id });
}

/** Buyer-facing hint for a failed Agreements call: fixed text, never the raw AWS message. */
export function awsErrorHint(err: unknown): string {
  return awsErrorText(err);
}
