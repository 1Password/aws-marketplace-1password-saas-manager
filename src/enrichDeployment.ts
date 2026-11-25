/**
 * "Deployed on AWS" enrichment — the PPA-drawdown signal.
 *
 * WHY buyers care (verified 2026-08-25 against AWS Marketplace Buyer Guide + the
 * AWS PPA billing documentation):
 *   Since 2025-05-01, only Marketplace products with the "Deployed on AWS" badge
 *   are eligible to RETIRE PPA/EDP commitment. SaaS not hosted on AWS is
 *   explicitly excluded. There is also a 25% Marketplace cap on commitment
 *   retirement, and that cap applies exclusively to AWS-deployed products.
 *
 * SOURCE (catalog.ts picks one per run):
 *   • Discovery API (the customer's AWS profile): `get-listing` returns a top-level `badges[]`
 *     array; badgeType "DEPLOYED_ON_AWS" is the flag.
 *   • AWS Marketplace MCP (no AWS profile): search hits carry `deployed_on_aws` (true/false).
 *     get_aws_marketplace_solution doesn't, so we search for the listing's title and read its hit.
 *     On a real portfolio the two agreed on every listing where Discovery had an answer.
 *
 * Three states per app:
 *   "yes"     — badges include DEPLOYED_ON_AWS  → counts toward PPA drawdown
 *   "no"      — listing has badges[] but none is DEPLOYED_ON_AWS  → NOT eligible
 *   "unknown" — Discovery returned no badges (null) or the fetch failed
 * Eligibility can change day-to-day (Partner Assessment Automation), so this
 * enrichment always re-derives from Discovery (which is cached, so cheap).
 *
 * Reads:  out/<provider>/match-results.json (+ selections.json)
 * Writes: out/<provider>/deployment.json  ({ [listingId]: DeploymentStatus })
 *
 * Run:  [SAAS_PROVIDER=…] node --env-file=.env --import tsx src/enrichDeployment.ts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getListing } from "./discovery.js";
import { chooseCatalog } from "./catalog.js";
import { deployedOnAwsMcp } from "./discoveryMcp.js";
import { matchResultsPath, selectionsPath, deploymentPath } from "./paths.js";
import { safeErrorMessage } from "./untrusted.js";

export type DeployedOnAws = "yes" | "no" | "unknown";
export interface DeploymentStatus {
  listingId: string;
  deployedOnAws: DeployedOnAws;
  /** Fulfillment types the listing supports (SAAS, AMI, CONTAINER, ML). */
  fulfillmentTypes?: string[];
  /** All badge types on the listing (for transparency in the report). */
  badges?: string[];
}

/** Which listing ids are "resolved" and therefore worth checking, with their titles. */
function resolvedListingIds(): { id: string; title: string }[] {
  const match = JSON.parse(readFileSync(matchResultsPath(), "utf8"));
  const selPath = selectionsPath();
  const selections: Record<string, { listingId?: string; none?: boolean }> = existsSync(selPath)
    ? JSON.parse(readFileSync(selPath, "utf8"))
    : {};
  const titles = new Map<string, string>();
  for (const m of match.matches ?? []) for (const c of m.candidates ?? []) if (c?.listingId) titles.set(c.listingId, c.title);
  const ids = new Set<string>();
  for (const m of match.matches ?? []) {
    if (m.status === "confirmed" && m.auto?.listingId) ids.add(m.auto.listingId);
  }
  for (const sel of Object.values(selections)) {
    if (sel?.listingId) ids.add(sel.listingId);
  }
  return [...ids].filter((id) => id.startsWith("prodview-")).map((id) => ({ id, title: titles.get(id) ?? "" }));
}

async function statusForMcp(listingId: string, title: string): Promise<DeploymentStatus> {
  if (!title) return { listingId, deployedOnAws: "unknown" };
  try {
    const d = await deployedOnAwsMcp(listingId, title);
    return { listingId, deployedOnAws: d === true ? "yes" : d === false ? "no" : "unknown", badges: d ? ["DEPLOYED_ON_AWS"] : [] };
  } catch {
    return { listingId, deployedOnAws: "unknown" };
  }
}

async function statusFor(listingId: string): Promise<DeploymentStatus> {
  try {
    const l = (await getListing(listingId))?.listing ?? (await getListing(listingId));
    const badges: any[] = l?.badges ?? [];
    const badgeTypes = badges.map((b) => b?.badgeType).filter(Boolean);
    const fulfillmentTypes: string[] = (l?.fulfillmentOptionSummaries ?? [])
      .map((f: any) => f?.fulfillmentOptionType)
      .filter(Boolean);
    let deployedOnAws: DeployedOnAws;
    if (badgeTypes.includes("DEPLOYED_ON_AWS")) deployedOnAws = "yes";
    else if (badges.length > 0) deployedOnAws = "no"; // has badges but not that one
    else deployedOnAws = "unknown";
    return { listingId, deployedOnAws, fulfillmentTypes, badges: badgeTypes };
  } catch {
    return { listingId, deployedOnAws: "unknown" };
  }
}

/** Bounded-concurrency map. Discovery is CLI-shelled + on-disk cached, so 4 is safe. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function main() {
  const items = resolvedListingIds();
  const ids = items.map((x) => x.id);
  const { mode } = await chooseCatalog();
  console.error(`Checking Deployed-on-AWS for ${ids.length} resolved product(s) via ${mode === "discovery" ? "the Discovery API" : "the AWS Marketplace MCP"}…`);
  const statuses = await pool(items, 4, (x) => (mode === "discovery" ? statusFor(x.id) : statusForMcp(x.id, x.title)));

  const byId: Record<string, DeploymentStatus> = {};
  const counts = { yes: 0, no: 0, unknown: 0 };
  for (const s of statuses) {
    byId[s.listingId] = s;
    counts[s.deployedOnAws]++;
  }
  writeFileSync(deploymentPath(), JSON.stringify(byId, null, 2));

  console.log(`\n=== Deployed-on-AWS (${ids.length} products) ===`);
  console.log(`  yes: ${counts.yes} · no: ${counts.no} · unknown: ${counts.unknown}`);
  console.log(`  → ${deploymentPath()}`);
  console.log(`  Note: only "yes" products count toward PPA/EDP commitment retirement (25% Marketplace cap; policy effective 2025-05-01).`);
}

main().catch((err) => { console.error(`ERROR: enrichDeployment failed: ${safeErrorMessage(err)}`); process.exitCode = 1; });
