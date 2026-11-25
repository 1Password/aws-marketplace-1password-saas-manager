/**
 * Which AWS Marketplace catalog source a run uses.
 *
 *   1. The customer's own AWS profile (Discovery API) — preferred. Used when `AWS_PROFILE` is set in
 *      `.env` and a one-listing test search with it succeeds. Complete vendor catalogs (PUBLISHER
 *      filter), categories, and Deployed-on-AWS badges.
 *   2. The public AWS Marketplace MCP — the fallback, needing no AWS account. Used when no profile is
 *      set, or the profile can't reach the Discovery API (missing permission, expired SSO session…).
 *
 * The bundle never uses AWS credentials the customer didn't name in `.env` (no default profile, no
 * ambient environment keys), and ships none of its own.
 *
 * run_consolidation decides once and passes CATALOG_SOURCE to every step, so one run never mixes
 * sources. A step run on its own decides for itself. The choice and the reason are saved to
 * out/<provider>/catalog-source.json for the report.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { SearchListingsCommand } from "@aws-sdk/client-marketplace-discovery";
import { configuredProfile, discoveryAuth } from "./discoveryAuth.js";
import { awsErrorText } from "./awsClients.js";
import { resolveSeller, listVendorProducts } from "./discovery.js";
import { resolveSellerMcp, listVendorProductsMcp } from "./discoveryMcp.js";
import type { CatalogSource } from "./matchVendor.js";
import { catalogSourcePath } from "./paths.js";

export type CatalogMode = "discovery" | "mcp";
export interface CatalogChoice {
  mode: CatalogMode;
  /** Plain-language reason, for the user (no secrets, no raw AWS messages). */
  reason: string;
  /** The profile tried, if any. */
  profile?: string;
}

export const CATALOG_LABEL: Record<CatalogMode, string> = {
  discovery: "your AWS profile (AWS Marketplace Discovery API)",
  mcp: "the public AWS Marketplace MCP (no AWS account needed)",
};

let decided: Promise<CatalogChoice> | undefined;

/** Decide the catalog source for this process (memoized). */
export function chooseCatalog(): Promise<CatalogChoice> {
  decided ??= decide();
  return decided;
}

async function decide(): Promise<CatalogChoice> {
  const profile = configuredProfile();
  const forced = (process.env.CATALOG_SOURCE ?? "").trim().toLowerCase();
  if (forced === "mcp") return { mode: "mcp", reason: "Set for this run.", profile };
  if (forced === "discovery") {
    if (!profile) return { mode: "mcp", reason: "No AWS profile is set in .env, so the AWS Marketplace MCP is used.", profile };
    return { mode: "discovery", reason: `Using AWS profile "${profile}".`, profile };
  }
  if (!profile) {
    return { mode: "mcp", reason: "No AWS profile is set in .env, so the AWS Marketplace MCP is used. For the most complete matching, set AWS_PROFILE to a read-only AWS Marketplace profile.", profile };
  }
  try {
    await discoveryAuth().client.send(new SearchListingsCommand({ searchText: "monitoring", maxResults: 1 }));
    return { mode: "discovery", reason: `AWS profile "${profile}" can use the Discovery API.`, profile };
  } catch (e) {
    return { mode: "mcp", reason: `${awsErrorText(e, `AWS profile "${profile}"`)} Using the AWS Marketplace MCP instead.`, profile };
  }
}

/** The vendor-catalog functions for a mode (matchVendor.ts). */
export function catalogFor(mode: CatalogMode): CatalogSource {
  return mode === "discovery"
    ? { resolveSeller, listVendorProducts }
    : { resolveSeller: resolveSellerMcp, listVendorProducts: listVendorProductsMcp };
}

export function saveCatalogChoice(c: CatalogChoice) {
  writeFileSync(catalogSourcePath(), JSON.stringify({ ...c, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function readCatalogChoice(): (CatalogChoice & { at?: string }) | undefined {
  try {
    const c = JSON.parse(readFileSync(catalogSourcePath(), "utf8"));
    return c?.mode === "discovery" || c?.mode === "mcp" ? c : undefined;
  } catch {
    return undefined;
  }
}
