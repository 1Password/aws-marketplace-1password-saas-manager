/**
 * Shadow-IT product suggestion.
 *
 * For an app the buyer has CONFIRMED is shadow IT (used, no contract on record),
 * a purchase is a valid action — so we suggest a Marketplace product to buy. Rather
 * than the heavy vendor-catalog matching (which needs AWS creds), we run a simple
 * AWS Marketplace MCP search on the app name + its category and surface the top hit
 * plus its buy / private-offer URLs. This is a SUGGESTION the buyer confirms, never
 * an asserted match — MCP search can return false positives, and shadow IT is a
 * net-new purchase, so a buyer-confirmed starting point is the right interaction.
 *
 * No AWS credentials required: the Marketplace MCP is the no-auth baseline source.
 *
 * Shared core: works identically for any SaaS provider — it consumes only the
 * normalized { name, vendor?, descriptor? } shape.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpClient } from "./mcpClient.js";
import { rewriteMarketplaceUrl } from "./marketplaceUrl.js";

const MARKETPLACE_MCP_URL = process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";
const CACHE_DIR = ".cache/marketplace-shadowit";

export const SHADOW_IT_NOTE =
  "Suggested Marketplace product from a search — confirm it's the product you use before buying.";

export interface ShadowItInput {
  name: string;
  vendor?: string;
  descriptor?: string;
}

export interface ShadowItSuggestion {
  app: string;
  /** The search query we used (name enriched with category, when available). */
  query: string;
  /** Whether the search found any Marketplace product for this app. */
  found: boolean;
  suggested?: { listingId: string; title: string; vendor?: string };
  /** Buy / private-offer / listing URLs for the suggested product, when present. */
  procurementUrl?: string;
  privateOfferUrl?: string;
  listingUrl?: string;
  note: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);

/**
 * Pull the call-to-action links out of a get_aws_marketplace_solution entry.
 * MAX_MCP attribution rewritten to the bundle's `ref_` + `src` (see marketplaceUrl.ts).
 */
function ctaLinks(sol: any): { procurementUrl?: string; privateOfferUrl?: string; listingUrl?: string } {
  const cta = sol?.call_to_action ?? {};
  return {
    procurementUrl: rewriteMarketplaceUrl(cta.procurement_url) || undefined,
    privateOfferUrl: rewriteMarketplaceUrl(cta.request_for_private_offer_url || cta.private_offer_url) || undefined,
    listingUrl: rewriteMarketplaceUrl(sol?.solution_url) || undefined,
  };
}

/**
 * Suggest a Marketplace product for one shadow-IT app. Pass a connected McpClient to
 * reuse it across many apps; omit it for a one-off (this creates + closes its own).
 * Cached on disk per app so repeat runs are deterministic and offline.
 */
export async function suggestShadowItProduct(app: ShadowItInput, sharedClient?: McpClient): Promise<ShadowItSuggestion> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = `${CACHE_DIR}/${slug(app.name)}.json`;
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as ShadowItSuggestion;
    // Self-migrate entries written before marketplaceUrl.ts was introduced;
    // idempotent on clean entries.
    cached.procurementUrl = rewriteMarketplaceUrl(cached.procurementUrl) || undefined;
    cached.privateOfferUrl = rewriteMarketplaceUrl(cached.privateOfferUrl) || undefined;
    cached.listingUrl = rewriteMarketplaceUrl(cached.listingUrl) || undefined;
    return cached;
  }

  const query = [app.name, app.descriptor].filter(Boolean).join(" ").trim() || app.name;
  const base: ShadowItSuggestion = { app: app.name, query, found: false, note: SHADOW_IT_NOTE };

  const client = sharedClient ?? new McpClient({ url: MARKETPLACE_MCP_URL, clientName: "consolidation-agent-shadowit" });
  if (!sharedClient) await client.connect();
  const sr = await client.callTool("search_aws_marketplace_solutions", { queries: [query], max_results: 5 });
  const results: any[] = sr?.results ?? [];
  if (results.length === 0) {
    writeFileSync(cacheFile, JSON.stringify(base, null, 2));
    return base;
  }
  // Prefer a hit whose vendor agrees with the app's vendor (when we have one);
  // otherwise take the top-ranked result.
  const vTokens = new Set(tokenize(app.vendor ?? ""));
  const pick =
    (vTokens.size &&
      results.find((r) => tokenize(r.vendor_name ?? "").some((t: string) => vTokens.has(t)))) ||
    results[0];
  const listingId: string | undefined = pick?.solution_id;
  if (!listingId) {
    writeFileSync(cacheFile, JSON.stringify(base, null, 2));
    return base;
  }
  let links: { procurementUrl?: string; privateOfferUrl?: string; listingUrl?: string } = {};
  try {
    const dr = await client.callTool("get_aws_marketplace_solution", { solution_ids: [listingId] });
    links = ctaLinks((dr?.solutions ?? [])[0] ?? {});
  } catch {
    /* CTAs optional — the suggestion still stands */
  }
  const out: ShadowItSuggestion = {
    ...base,
    found: true,
    suggested: { listingId, title: pick.solution_name ?? pick.title ?? pick.name ?? listingId, vendor: pick.vendor_name || undefined },
    ...links,
  };
  writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}
