/**
 * Agreements-tier enrichment — detect which portfolio apps the buyer ALREADY has an
 * AWS Marketplace agreement for (already consolidated), so the report pulls them out
 * of the opportunity and focuses on what's not yet moved.
 *
 * REAL join (default): search the buyer's PurchaseAgreements, describe each, resolve
 * every agreement resource id via Discovery get-product (→ productName + product id),
 * and match to a confirmed portfolio app — exact Marketplace product UUID, else
 * normalized product-name (the resource id may be a `prod-*` in a different namespace
 * from the portfolio's UUID, so name is the shared signal). Only ACTIVE agreements
 * count as "already on Marketplace"; lapsed ones are left as renewal opportunities.
 * Degrades cleanly: no overlap → empty result (honest), report renders no §0.
 *
 * DEMO fallback (AGREEMENTS_DEMO_ASSUMED=1): synthesize assumed agreements for a few
 * matched apps (flagged assumed:true) for a presentation when the connected account
 * has no agreements overlapping its portfolio.
 *
 * Reads:  out/<provider>/analytics-results.json
 * Writes: out/<provider>/agreements.json
 *
 * Run:  [SAAS_PROVIDER=…] [AGREEMENTS_DEMO_ASSUMED=1] node --env-file=.env --import tsx src/enrichAgreements.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { analyticsResultsPath, agreementsPath } from "./paths.js";
import {
  searchRealAgreements, describeAgreement, matchAgreementProductToApp,
  assumedAgreementFor, type AppForJoin, type AssumedAgreement,
} from "./agreements.js";
import { getListing, getProduct } from "./discovery.js";
import { configuredProfile } from "./discoveryAuth.js";
import { awsErrorHint } from "./probes.js";
import { safeErrorMessage } from "./untrusted.js";

interface AppRec {
  app: string; vendor?: string; status: string; spend?: number;
  resolved?: { listingId?: string; title?: string } | null;
}

async function realJoin(analytics: any) {
  const apps: AppRec[] = analytics.apps ?? [];
  const confirmed = apps.filter((a) => a.status === "confirmed" && a.resolved?.listingId);

  // Portfolio side: resolve each confirmed app's Marketplace product UUID + title.
  const appsForJoin: AppForJoin[] = [];
  for (const a of confirmed) {
    let productUuid: string | undefined;
    try {
      const l = (await getListing(a.resolved!.listingId!))?.listing;
      const ent = (l?.associatedEntities ?? []).find((e: any) => e.product?.productId);
      productUuid = ent?.product?.productId;
    } catch { /* best-effort; fall back to name match */ }
    appsForJoin.push({ app: a.app, vendor: a.vendor, productUuid, productTitle: a.resolved?.title });
  }

  // Buyer side: their agreements → resolved products → join to confirmed apps.
  const summaries = await searchRealAgreements();
  const byApp: Record<string, any> = {};
  const resolvedProducts: any[] = [];
  let matchedUsd = 0;
  for (const s of summaries) {
    const detail = await describeAgreement(s.agreementId);
    const active = /^ACTIVE/i.test(detail.status);
    for (const r of detail.resources) {
      const prod = await getProduct(r.id);
      if (!prod) { resolvedProducts.push({ resourceId: r.id, resolved: null }); continue; }
      resolvedProducts.push({ resourceId: r.id, productId: prod.productId, productName: prod.productName, active });
      if (!active) continue; // lapsed/terminated → renewal opportunity, not "already done"
      const m = matchAgreementProductToApp({ productId: prod.productId, productName: prod.productName }, appsForJoin);
      if (m && !byApp[m.app.app]) {
        byApp[m.app.app] = {
          app: m.app.app, vendor: m.app.vendor, agreementId: detail.agreementId, status: detail.status,
          startTime: detail.startTime, endTime: detail.endTime, committedUsd: detail.committedUsd ?? 0,
          productId: prod.productId, productName: prod.productName, matchedBy: m.matchedBy, assumed: false,
        };
        matchedUsd += detail.committedUsd ?? 0;
      }
    }
  }
  return { realCount: summaries.length, byApp, resolvedProducts, matchedUsd };
}

/** DEMO ONLY: synthesize assumed agreements for a few matched apps. */
function demoAssumed(analytics: any, asOf: string) {
  const matched = (analytics.apps ?? []).filter((a: any) => a.status === "confirmed" || a.status === "needs_selection");
  const explicit = process.env.AGREEMENTS_ASSUMED_APPS;
  let chosen: any[];
  if (explicit) {
    const want = explicit.split(",").map((s) => s.trim().toLowerCase());
    chosen = matched.filter((m: any) => want.includes(m.app.toLowerCase()));
  } else {
    const sorted = [...matched].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
    chosen = [];
    for (let i = 1; i < sorted.length && chosen.length < 5; i += 3) chosen.push(sorted[i]);
  }
  const agreements: AssumedAgreement[] = chosen.map((m) => assumedAgreementFor({ app: m.app, vendor: m.vendor, annualSpend: m.spend }, asOf));
  const byApp: Record<string, AssumedAgreement> = {};
  for (const a of agreements) byApp[a.app] = a;
  return { agreements, byApp };
}

async function main() {
  const analytics = JSON.parse(readFileSync(analyticsResultsPath(), "utf8"));
  const asOf = process.env.DEMO_AS_OF ?? analytics.as_of ?? new Date().toISOString().slice(0, 10);
  const generatedFrom = analytics.generated_from;
  const outPath = agreementsPath();

  if (process.env.AGREEMENTS_DEMO_ASSUMED === "1") {
    const { agreements, byApp } = demoAssumed(analytics, asOf);
    writeFileSync(outPath, JSON.stringify({
      connected: true,
      assumed: true,
      note: "DEMO (AGREEMENTS_DEMO_ASSUMED=1): assumed agreements for a few portfolio vendors — NOT real matching.",
      generatedFrom, asOf,
      committedUsd: agreements.reduce((s, a) => s + a.committedUsd, 0),
      agreements, byApp,
    }, null, 2));
    console.log(`\n=== Agreements enrichment (${generatedFrom}) — DEMO assumed ===`);
    console.log(`  assumed already-on-Marketplace: ${agreements.length} apps · ${agreements.map((a) => a.app).join(", ")}`);
    console.log(`  → ${outPath}`);
    return;
  }

  // Agreements are the customer's own purchases: they need their AWS profile. Without one, say so
  // plainly (not an error) — the skill asks the user instead.
  if (!configuredProfile()) {
    const reason = "Optional: no AWS profile is set (AWS_PROFILE in .env), so your AWS Marketplace purchases can't be read. Tell your agent which applications you already buy there.";
    writeFileSync(outPath, JSON.stringify({ connected: false, assumed: false, reason, generatedFrom, asOf, byApp: {} }, null, 2));
    console.log(`\n=== Agreements enrichment (${generatedFrom}) — skipped ===\n  ${reason}\n  → ${outPath}`);
    return;
  }

  // REAL resolution + join.
  let realCount = -1, matchedCount = 0, matchedUsd = 0;
  let byApp: Record<string, any> = {};
  let resolved: any[] = [];
  try {
    const r = await realJoin(analytics);
    realCount = r.realCount; byApp = r.byApp; matchedUsd = r.matchedUsd;
    matchedCount = Object.keys(r.byApp).length; resolved = r.resolvedProducts;
  } catch (e: any) {
    // Access/credentials (or any other) failure: we could not read the buyer's
    // agreements, so record NOT connected with the reason — never an empty
    // "connected, zero agreements" result, which would be a false claim.
    const reason = awsErrorHint(e);
    console.error(`  Agreements enrichment skipped: ${reason}`);
    writeFileSync(outPath, JSON.stringify({
      connected: false,
      assumed: false,
      reason,
      generatedFrom, asOf,
      byApp: {},
    }, null, 2));
    console.log(`\n=== Agreements enrichment (${generatedFrom}) — NOT connected ===`);
    console.log(`  ${reason}`);
    console.log(`  → ${outPath}`);
    return;
  }

  writeFileSync(outPath, JSON.stringify({
    connected: true,
    assumed: false,
    note: matchedCount
      ? undefined
      : "Agreements API connected; none of the buyer's agreements overlap this portfolio (nothing already on Marketplace).",
    realAgreementCount: realCount,
    matchedCount,
    generatedFrom, asOf,
    committedUsd: matchedUsd,
    agreements: Object.values(byApp),
    byApp,
    resolvedProducts: resolved,
  }, null, 2));

  const named = resolved.filter((r) => r.productName);
  console.log(`\n=== Agreements enrichment (${generatedFrom}) ===`);
  console.log(`  real PurchaseAgreements on account: ${realCount}`);
  console.log(`  resolved products: ${named.length}/${resolved.length}${named.length ? ` (e.g. ${named.slice(0, 3).map((r) => r.productName).join(", ")})` : ""}`);
  console.log(`  already-on-Marketplace matches: ${matchedCount}${matchedCount ? ` · $${Math.round(matchedUsd).toLocaleString()} committed` : " (no portfolio overlap — honest empty)"}`);
  console.log(`  → ${outPath}`);
}

main().catch((err) => { console.error(`ERROR: enrichAgreements failed: ${safeErrorMessage(err)}`); process.exitCode = 1; });
