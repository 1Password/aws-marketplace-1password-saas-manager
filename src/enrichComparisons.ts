/**
 * "Review comparable solutions on AWS Marketplace" enrichment.
 *
 * For each confirmed (owned + matched) app, gather a few comparable Marketplace
 * products and build a side-by-side comparison the buyer can review WITHOUT leaving
 * for a purchase. This follows the Marketplace MCP `comparison` workflow, but built
 * deterministically from the MCP's STRUCTURED catalog data (get_aws_marketplace_solution):
 * purchase rank, review rating + the 4 sentiment dimensions, pricing options,
 * standard-contract flag, highlights, fulfillment, and links.
 *
 * The MCP splits the comparison job: it supplies the method + data, the caller
 * assembles the matrix. We assemble it here from catalog fields (no LLM needed).
 * The MCP's narrative feature/integration research (research_aws_marketplace_solution)
 * needs an LLM to stitch into a feature table — deferred to the live agent;
 * this enrichment is the deterministic, cache-friendly baseline.
 *
 * Candidate comparables come from get_aws_marketplace_related_solutions(seed); when
 * that's empty (it often is), we fall back to search_aws_marketplace_solutions on the
 * seed's own top category, excluding the seed and its vendor.
 *
 * Reads:  out/<provider>/report.json  (confirmed apps + resolved prodview- ids)
 * Writes: out/<provider>/comparisons.json  ({ [app]: Comparison })
 * Cache:  .cache/marketplace-comparisons/<seedListingId>.json
 *
 * Run:  [SAAS_PROVIDER=…] npm run enrich-comparisons [--max N] [--peers K]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpClient } from "./mcpClient.js";
import { reportJsonPath, comparisonsPath } from "./paths.js";
import { rewriteMarketplaceUrl } from "./marketplaceUrl.js";
import { safeErrorMessage } from "./untrusted.js";

const CACHE_DIR = ".cache/marketplace-comparisons";
const MARKETPLACE_MCP_URL = process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };

type Polarity = "POSITIVE" | "MIXED" | "NEGATIVE";
interface ProductRow {
  listingId: string;
  name: string;
  vendor?: string;
  isSeed: boolean;
  url?: string;
  bestRank?: { category: string; rank: number } | null;
  rating?: number | null;
  reviewCount?: number | null;
  sentiments: Partial<Record<"functionality" | "ease_of_use" | "customer_service" | "cost_effectiveness", Polarity>>;
  highlights: string[];
  pricingOptions: { name?: string; description?: string }[];
  hasStandardContract?: boolean | null;
  freeTrial?: boolean | null;
  fulfillment: string[];
  categories: string[];
}
interface Comparison {
  app: string;
  seedListingId: string;
  candidateSource: "related" | "category-search" | "none";
  products: ProductRow[];
}

/** Build a comparison row from one get_aws_marketplace_solution entry. */
function toRow(sol: any, isSeed: boolean): ProductRow {
  const rankings: { category: string; rank: number }[] = sol?.rankings ?? [];
  const bestRank = rankings.length
    ? rankings.reduce((a, b) => (b.rank < a.rank ? b : a))
    : null;
  const sentiments: ProductRow["sentiments"] = {};
  for (const s of sol?.review_sentiments ?? []) {
    if (s?.sentiment_category && s?.overall_polarity) sentiments[s.sentiment_category as keyof ProductRow["sentiments"]] = s.overall_polarity;
  }
  return {
    listingId: sol?.solution_id,
    name: sol?.solution_name ?? sol?.solution_id,
    vendor: sol?.vendor_name || undefined,
    isSeed,
    // Rewrite MAX_MCP attribution to the bundle's `ref_` + `src` (see marketplaceUrl.ts).
    url: rewriteMarketplaceUrl(sol?.solution_url) || undefined,
    bestRank,
    rating: sol?.reviews_summary?.average_rating ?? null,
    reviewCount: sol?.reviews_summary?.reviews_count ?? null,
    sentiments,
    highlights: sol?.highlights ?? [],
    pricingOptions: sol?.pricing_options ?? [],
    hasStandardContract: sol?.has_standard_contract ?? null,
    freeTrial: sol?.free_trial_available ?? null,
    fulfillment: sol?.fulfillment_options_types ?? [],
    categories: sol?.categories ?? [],
  };
}

interface ConfirmedApp { app: string; status: string; annualSpend?: number; resolved?: { listingId?: string } }

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const maxApps = Number(arg("--max") ?? 12);
  const peers = Number(arg("--peers") ?? 4);

  const report = JSON.parse(readFileSync(reportJsonPath(), "utf8")) as { apps: ConfirmedApp[] };
  const confirmed = report.apps
    .filter((a) => a.status === "confirmed" && a.resolved?.listingId?.startsWith("prodview-"))
    .sort((x, y) => (y.annualSpend ?? 0) - (x.annualSpend ?? 0))
    .slice(0, maxApps);
  console.error(`Building comparisons for ${confirmed.length} confirmed app(s) (top ${maxApps} by spend, ${peers} peers each)…`);

  const client = new McpClient({ url: MARKETPLACE_MCP_URL, clientName: "consolidation-agent-comparisons" });
  await client.connect();

  // Batch-fetch solution detail with a small on-run memo (a peer may recur across apps).
  const detailMemo = new Map<string, any>();
  const getDetails = async (ids: string[]): Promise<Map<string, any>> => {
    const need = ids.filter((id) => !detailMemo.has(id));
    for (let i = 0; i < need.length; i += 10) {
      const batch = need.slice(i, i + 10);
      const resp = await client.callTool("get_aws_marketplace_solution", { solution_ids: batch });
      for (const sol of resp?.solutions ?? []) detailMemo.set(sol.solution_id, sol);
      // Any id the API omitted (bad/withdrawn) → memo null so we don't refetch.
      for (const id of batch) if (!detailMemo.has(id)) detailMemo.set(id, null);
    }
    return new Map(ids.map((id) => [id, detailMemo.get(id)]));
  };

  const out: Record<string, Comparison> = {};
  for (const a of confirmed) {
    const seed = a.resolved!.listingId!;
    const cacheFile = `${CACHE_DIR}/${seed}.json`;
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as Comparison;
      // Self-migrate entries written before marketplaceUrl.ts was introduced;
      // idempotent on clean entries.
      for (const p of cached.products) p.url = rewriteMarketplaceUrl(p.url) || undefined;
      out[a.app] = cached;
      console.error(`  ${a.app}: cached (${cached.products.length} products)`);
      continue;
    }

    // Seed detail (also gives us its top category for the search fallback).
    const seedDetail = (await getDetails([seed])).get(seed);
    if (!seedDetail) { console.error(`  ${a.app}: seed ${seed} not found; skipping`); continue; }

    // Candidate comparables: related_solutions first, category search as fallback.
    let source: Comparison["candidateSource"] = "related";
    let candidateIds: string[] = [];
    const rel = await client.callTool("get_aws_marketplace_related_solutions", { solution_ids: [seed] });
    candidateIds = (rel?.results?.[0]?.related_solutions ?? []).map((r: any) => r.solution_id).filter(Boolean);

    if (!candidateIds.length) {
      const topCategory: string | undefined = seedDetail.categories?.[0];
      if (topCategory) {
        source = "category-search";
        const sr = await client.callTool("search_aws_marketplace_solutions", { queries: [topCategory], max_results: 12 });
        const seedVendor = (seedDetail.vendor_name ?? "").toLowerCase();
        candidateIds = (sr?.results ?? [])
          .filter((r: any) => r.solution_id !== seed && (r.vendor_name ?? "").toLowerCase() !== seedVendor)
          .map((r: any) => r.solution_id)
          .filter(Boolean);
      } else {
        source = "none";
      }
    }
    candidateIds = [...new Set(candidateIds)].filter((id) => id !== seed).slice(0, peers);

    const details = await getDetails(candidateIds);
    const products: ProductRow[] = [toRow(seedDetail, true)];
    for (const id of candidateIds) {
      const d = details.get(id);
      if (d) products.push(toRow(d, false));
    }

    const cmp: Comparison = { app: a.app, seedListingId: seed, candidateSource: source, products };
    out[a.app] = cmp;
    writeFileSync(cacheFile, JSON.stringify(cmp, null, 2));
    console.error(`  ${a.app}: ${products.length} products (source: ${source})`);
  }

  const outPath = comparisonsPath();
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  const withPeers = Object.values(out).filter((c) => c.products.length > 1).length;
  console.log(`\n=== Comparisons (${confirmed.length} apps) ===`);
  console.log(`  ${withPeers} apps have ≥1 comparable · ${Object.keys(out).length - withPeers} seed-only`);
  console.log(`  → ${outPath}`);
}

main().catch((err) => {
  console.error(`ERROR: enrichComparisons failed: ${safeErrorMessage(err)}`);
  process.exitCode = 1;
});
