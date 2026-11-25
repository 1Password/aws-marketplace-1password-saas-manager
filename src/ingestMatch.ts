/**
 * Orchestrator — live end-to-end, vendor-first matching.
 *
 *   active SaaS source → normalize → aggregate → vendor-first match
 *   (Discovery catalog per vendor) → per-app data-contract records.
 *
 * Run:  node --env-file=.env --import tsx src/ingestMatch.ts [--max N]
 *
 * Output (match-results.json) is the structured contract a UI or the agent
 * consumes: per app a status
 * (confirmed | needs_selection | not_on_marketplace), the vendor's candidate
 * products, and any auto pre-fill. No SKU is asserted that can't be verified.
 *
 * Vendor catalogs come from the customer's AWS profile (Discovery API) when it's set and works,
 * otherwise from the public AWS Marketplace MCP (catalog.ts). This step also starts a fresh
 * MCP health log (mcpShapes.ts) for the run.
 */

import { writeFileSync } from "node:fs";
import { activeSaaSProvider } from "./saasAdapters.js";
import { matchVendorApp, type VendorMatch } from "./matchVendor.js";
import { matchResultsPath, mcpHealthPath } from "./paths.js";
import { chooseCatalog, catalogFor, saveCatalogChoice, CATALOG_LABEL } from "./catalog.js";
import { resetMcpHealth } from "./mcpShapes.js";
import { safeErrorMessage } from "./untrusted.js";

/** Bounded-concurrency map with a progress counter. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
      if (++done % 50 === 0) console.error(`  …matched ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function main() {
  const maxArg = process.argv.indexOf("--max");
  const max = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : Infinity;

  // Provider-agnostic: pull the active source's portfolio (each provider carries
  // its own ingest), then match. No provider branching here — adding a SaaS-management source is
  // a new provider module, not an edit to this orchestrator.
  const provider = activeSaaSProvider();
  console.error(`Pulling ${provider.label} portfolio…`);
  const { apps, contractCount, note, noContractApps = [] } = await provider.pull({ max });
  if (note) console.error(`  ${note}`);

  resetMcpHealth(mcpHealthPath());
  const choice = await chooseCatalog();
  saveCatalogChoice(choice);
  const catalog = catalogFor(choice.mode);
  console.error(`Vendor-first matching against AWS Marketplace using ${CATALOG_LABEL[choice.mode]}. ${choice.reason}`);
  // Shared default matcher, overridable per provider (matching is the one
  // per-provider customizable step).
  const matcher = provider.matcher ?? matchVendorApp;
  const matches: VendorMatch[] = await pool(apps, 4, (app) =>
    matcher({
      name: app.name, vendor: app.vendor, descriptor: app.descriptor,
      annualSpend: app.annualSpend, seats: app.seats, renewals: app.renewals,
      lineItemDescriptions: app.lineItemDescriptions,
    }, catalog),
  );
  // Carry adoption alongside each match (pool preserves order → matches[i] ↔ apps[i]).
  // Persisted for the confidence-bucketing work; the report reads it where present.
  const enriched = matches.map((m, i) => (apps[i].adoption ? { ...m, adoption: apps[i].adoption } : m));

  const statusCounts = { confirmed: 0, needs_selection: 0, not_on_marketplace: 0 };
  for (const m of enriched) statusCounts[m.status]++;

  const out = {
    generatedFrom: provider.label,
    catalogSource: choice.mode,
    contracts: contractCount,
    apps: apps.length,
    statusCounts,
    noContractCount: noContractApps.length,
    noContractApps,
    matches: enriched.sort((a, b) => (b.annualSpend ?? 0) - (a.annualSpend ?? 0)),
  };
  const outPath = matchResultsPath();
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\n=== Vendor-first match summary (${out.generatedFrom}) ===`);
  console.log(`  contracts=${out.contracts}  apps=${out.apps}`);
  console.log(`  confirmed=${statusCounts.confirmed}  needs_selection=${statusCounts.needs_selection}  not_on_marketplace=${statusCounts.not_on_marketplace}`);
  if (noContractApps.length) console.log(`  no-contract (used, uncontracted)=${noContractApps.length}`);
  console.log(`\n  Full results → ${outPath}`);
}

main().catch((err) => {
  console.error(`ERROR: ingestMatch failed: ${safeErrorMessage(err)}`);
  process.exitCode = 1;
});
