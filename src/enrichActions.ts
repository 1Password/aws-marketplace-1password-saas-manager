/**
 * Action-URL enrichment — fetch the buyer's "act on it" links for the products
 * they can transact: the Marketplace **procurement** URL ("Buy on Marketplace")
 * and, where the seller offers it, the **private-offer** URL ("Request a private
 * offer") + a **demo** URL. These come from the AWS Marketplace MCP
 * `get_aws_marketplace_solution` → `call_to_action` (the same source the original
 * report used; the URLs carry MCP campaign tracking).
 *
 * Scope: only RESOLVED products — a confirmed match's auto-selected listing, or a
 * pending app the buyer has picked in selections.json. Pending apps with no
 * choice yet get no action links (you confirm the product first, then act).
 *
 * Reads:  out/<provider>/match-results.json (+ selections.json)
 * Writes: out/<provider>/actions.json  ({ [listingId]: ActionLinks })
 * Cache:  .cache/marketplace-actions/<listingId>.json
 *
 * Run:  [SAAS_PROVIDER=…] node --env-file=.env --import tsx src/enrichActions.ts
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpClient } from "./mcpClient.js";
import { matchResultsPath, selectionsPath, actionsPath } from "./paths.js";
import { rewriteMarketplaceUrl } from "./marketplaceUrl.js";
import { safeErrorMessage } from "./untrusted.js";

const CACHE_DIR = ".cache/marketplace-actions";
const MARKETPLACE_MCP_URL = process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";

export interface ActionLinks {
  listingId: string;
  procurementUrl?: string;
  privateOfferUrl?: string;
  demoUrl?: string;
  freeTrialUrl?: string;
  /** The Marketplace product page — always useful as a fallback "View listing". */
  listingUrl?: string;
}

/**
 * Pull the call-to-action links out of one get_aws_marketplace_solution entry.
 * Field names verified live (2026-08-25): `procurement_url`,
 * `request_for_private_offer_url`, `request_for_demo_url`, `procure_free_trial_url`.
 * (Fallback aliases kept in case the API varies.)
 */
function toActionLinks(sol: any): ActionLinks {
  const cta = sol?.call_to_action ?? {};
  // Rewrite MAX_MCP attribution to the bundle's `ref_` + `src` (see marketplaceUrl.ts).
  return {
    listingId: sol?.solution_id,
    procurementUrl: rewriteMarketplaceUrl(cta.procurement_url) || undefined,
    privateOfferUrl: rewriteMarketplaceUrl(cta.request_for_private_offer_url || cta.private_offer_url) || undefined,
    demoUrl: rewriteMarketplaceUrl(cta.request_for_demo_url || cta.demo_url) || undefined,
    freeTrialUrl: rewriteMarketplaceUrl(cta.procure_free_trial_url) || undefined,
    listingUrl: rewriteMarketplaceUrl(sol?.solution_url) || undefined,
  };
}

/** Re-apply the bundle's attribution to a cached ActionLinks — self-migrates entries
 * written before marketplaceUrl.ts was introduced. Idempotent on clean entries. */
function migrateActionLinks(a: ActionLinks): ActionLinks {
  return {
    listingId: a.listingId,
    procurementUrl: rewriteMarketplaceUrl(a.procurementUrl) || undefined,
    privateOfferUrl: rewriteMarketplaceUrl(a.privateOfferUrl) || undefined,
    demoUrl: rewriteMarketplaceUrl(a.demoUrl) || undefined,
    freeTrialUrl: rewriteMarketplaceUrl(a.freeTrialUrl) || undefined,
    listingUrl: rewriteMarketplaceUrl(a.listingUrl) || undefined,
  };
}

function cachedOrNull(listingId: string): ActionLinks | null {
  const f = `${CACHE_DIR}/${listingId}.json`;
  return existsSync(f) ? migrateActionLinks(JSON.parse(readFileSync(f, "utf8")) as ActionLinks) : null;
}

/** Which listing ids are "resolved" and therefore actionable. */
function resolvedListingIds(): string[] {
  const match = JSON.parse(readFileSync(matchResultsPath(), "utf8"));
  const selPath = selectionsPath();
  const selections: Record<string, { listingId?: string; none?: boolean }> = existsSync(selPath)
    ? JSON.parse(readFileSync(selPath, "utf8"))
    : {};
  const ids = new Set<string>();
  for (const m of match.matches ?? []) {
    if (m.status === "confirmed" && m.auto?.listingId) ids.add(m.auto.listingId);
  }
  for (const sel of Object.values(selections)) {
    if (sel?.listingId) ids.add(sel.listingId);
  }
  // Only Marketplace listing ids (prodview-*) are valid solution_ids.
  return [...ids].filter((id) => id.startsWith("prodview-"));
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const ids = resolvedListingIds();
  console.error(`Enriching action URLs for ${ids.length} resolved product(s)…`);

  const links: Record<string, ActionLinks> = {};
  const toFetch: string[] = [];
  for (const id of ids) {
    const c = cachedOrNull(id);
    if (c) links[id] = c;
    else toFetch.push(id);
  }
  console.error(`  ${ids.length - toFetch.length} cached · ${toFetch.length} to fetch`);

  if (toFetch.length) {
    const client = new McpClient({ url: MARKETPLACE_MCP_URL, clientName: "consolidation-agent-actions" });
    await client.connect();
    // get_aws_marketplace_solution accepts up to 10 solution_ids per call.
    for (let i = 0; i < toFetch.length; i += 10) {
      const batch = toFetch.slice(i, i + 10);
      const resp = await client.callTool("get_aws_marketplace_solution", { solution_ids: batch });
      for (const sol of resp?.solutions ?? []) {
        const a = toActionLinks(sol);
        if (!a.listingId) continue;
        links[a.listingId] = a;
        writeFileSync(`${CACHE_DIR}/${a.listingId}.json`, JSON.stringify(a, null, 2));
      }
      console.error(`  …fetched ${Math.min(i + 10, toFetch.length)}/${toFetch.length}`);
    }
  }

  const outPath = actionsPath();
  writeFileSync(outPath, JSON.stringify(links, null, 2));

  const withBuy = Object.values(links).filter((l) => l.procurementUrl).length;
  const withPO = Object.values(links).filter((l) => l.privateOfferUrl).length;
  console.log(`\n=== Action URLs (${ids.length} products) ===`);
  console.log(`  Buy on Marketplace: ${withBuy} · Request private offer: ${withPO}`);
  console.log(`  → ${outPath}`);
}

main().catch((err) => {
  console.error(`ERROR: enrichActions failed: ${safeErrorMessage(err)}`);
  process.exitCode = 1;
});
