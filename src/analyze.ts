/**
 * Consolidation analytics runner.
 *
 * Reads the vendor-first match contract (match-results.json) + any buyer
 * selections (selections.json), runs the consolidation math (consolidationSummary.ts),
 * and writes analytics-results.json: spend split into
 * Confirmed / Pending selection / Not-on-Marketplace buckets, renewal timing,
 * and per-app records (with candidates) for the report.
 *
 * Run:  node --env-file=.env --import tsx src/analyze.ts [--as-of YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { consolidationSummary } from "./consolidationSummary.js";
import { activeSaaSProvider } from "./saasAdapters.js";
import { matchResultsPath, analyticsResultsPath, selectionsPath } from "./paths.js";
import { safeErrorMessage } from "./untrusted.js";


const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

async function main() {
  const asOf = arg("--as-of") ?? process.env.DEMO_AS_OF ?? new Date().toISOString().slice(0, 10);
  const inPath = arg("--in") ?? matchResultsPath();
  const selPath = selectionsPath();
  const match = JSON.parse(readFileSync(inPath, "utf8"));
  const selections = existsSync(selPath) ? JSON.parse(readFileSync(selPath, "utf8")) : {};

  const payload = {
    as_of: asOf,
    generated_from: match.generatedFrom ?? activeSaaSProvider().label,
    capabilities: activeSaaSProvider().capabilities,
    matches: match.matches ?? [],
    selections,
  };

  const r = consolidationSummary(payload);
  const outPath = analyticsResultsPath();
  writeFileSync(outPath, JSON.stringify(r, null, 2));

  const c = r.counts;
  const b = r.renewal_buckets;
  console.log(`\n=== Consolidation analysis (${r.generated_from}, as of ${r.as_of}) ===`);
  console.log(`  Confirmed:          ${String(c.confirmed).padStart(3)} apps · ${usd(r.confirmed_usd)}`);
  console.log(`    ↳ renewing ≤90d:  ${usd(r.renewing_90d_confirmed_usd ?? 0)}`);
  console.log(`  Pending selection:  ${String(c.needs_selection).padStart(3)} apps · ${usd(r.pending_usd)}  (buyer must confirm which product)`);
  console.log(`  Not on Marketplace: ${String(c.not_on_marketplace).padStart(3)} apps · ${usd(r.not_on_marketplace_usd)}`);
  const sel = Object.keys(selections).length;
  if (sel) console.log(`  (applied ${sel} buyer selection${sel === 1 ? "" : "s"} from selections.json)`);
  console.log(`\n  Confirmed renewal timing:`);
  for (const k of ["le_90d", "le_1yr", "later", "lapsed", "unknown"]) {
    const x = b.confirmed?.[k];
    if (x) console.log(`    ${k.padEnd(8)}  ${String(x.count).padStart(3)} apps  ${usd(x.usd)}`);
  }
  console.log(`\n  ${r.disclaimer}`);
  console.log(`\n  Full analysis → ${outPath}`);
}

main().catch((err) => { console.error(`ERROR: analyze failed: ${safeErrorMessage(err)}`); process.exitCode = 1; });
