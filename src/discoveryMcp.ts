/**
 * Vendor catalog lookups through the public AWS Marketplace MCP: no AWS account or key needed.
 *
 * The fallback catalog source (catalog.ts): used when the customer hasn't set an AWS profile, or
 * theirs can't reach the Discovery API. Same interface as resolveSeller / listVendorProducts in
 * discovery.ts, so matchVendor.ts treats both the same. Compared on a real 315-application
 * portfolio, the two agreed on 99% of applications by ACV.
 *
 * Differences from Discovery:
 *   • The MCP's search has no seller id and no PUBLISHER filter. A vendor's catalog is the search
 *     hits whose vendor_name is that seller, so it's only as complete as the search: a listing that
 *     doesn't rank for the vendor's name can be missed (mostly an issue for very large sellers).
 *   • The seller "id" returned here is the vendor display name.
 *   • Listings carry no categories; "Deployed on AWS" comes from the search hit's deployed_on_aws.
 *
 * Every response is shape-checked by mcpClient.ts (mcpShapes.ts) before it gets here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { McpClient } from "./mcpClient.js";
import { isFresh, type SellerResolution, type VendorProduct } from "./discovery.js";

const MCP_URL = process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";
const CACHE_DIR = ".cache/mcp-catalog";
const PAGE = 100;
const MAX_PAGES = 3;

let client: McpClient | undefined;
let connecting: Promise<void> | undefined;
async function mcp(): Promise<McpClient> {
  if (!client) {
    client = new McpClient({ url: MCP_URL, clientName: "consolidation-agent-catalog" });
    connecting = client.connect();
  }
  await connecting;
  return client;
}

interface Hit { solution_id: string; solution_name?: string; vendor_name?: string; deployed_on_aws?: boolean }

/** Search the MCP for `query`, following next_cursor up to MAX_PAGES. Cached on disk for a week. */
async function search(query: string): Promise<Hit[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = `${CACHE_DIR}/${createHash("sha1").update(query.toLowerCase()).digest("hex").slice(0, 16)}.json`;
  if (isFresh(file)) return JSON.parse(readFileSync(file, "utf8"));
  const c = await mcp();
  const hits: Hit[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args: Record<string, unknown> = { queries: [query], max_results: PAGE };
    if (cursor) args.cursor = cursor;
    const r = await c.callTool("search_aws_marketplace_solutions", args);
    const res: Hit[] = r?.results ?? [];
    hits.push(...res);
    cursor = r?.next_cursor;
    if (!cursor || res.length < PAGE) break;
  }
  writeFileSync(file, JSON.stringify(hits));
  return hits;
}

// Same name rules as discovery.ts.
const LEGAL = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
  "gmbh", "srl", "pty", "sa", "ag", "plc", "bv", "nv", "pbc",
]);
const normV = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nameTokens = (s: string | undefined, minLen = 1) => normV(s).split(" ").filter((t) => t.length >= minLen && !LEGAL.has(t));

const hitsByVendor = new Map<string, Hit[]>();

export async function resolveSellerMcp(vendorName: string): Promise<SellerResolution | undefined> {
  const hits = await search(vendorName);
  const wantExact = nameTokens(vendorName).sort();
  const wantBrand = new Set(nameTokens(vendorName, 3));
  const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

  let best: { name: string; rank: number } | undefined;
  for (const h of hits) {
    const name = h.vendor_name;
    if (!name) continue;
    let rank = 0;
    if (wantExact.length && setEq(wantExact, nameTokens(name).sort())) rank = 2;
    else if (nameTokens(name, 3).some((t) => wantBrand.has(t))) rank = 1;
    if (rank > (best?.rank ?? 0)) best = { name, rank };
  }
  if (!best) return undefined;
  // Keep every hit from this seller; a follow-up search on the seller's own name can
  // surface listings the vendor-name search ranked lower.
  const own = (hs: Hit[]) => hs.filter((h) => h.vendor_name === best!.name);
  const pool = new Map(own(hits).map((h) => [h.solution_id, h]));
  if (normV(best.name) !== normV(vendorName)) for (const h of own(await search(best.name))) pool.set(h.solution_id, h);
  hitsByVendor.set(best.name, [...pool.values()]);
  return { sellerId: best.name, displayName: best.name, strength: best.rank === 2 ? "exact" : "brand" };
}

export async function listVendorProductsMcp(sellerKey: string): Promise<VendorProduct[]> {
  return (hitsByVendor.get(sellerKey) ?? []).map((h) => ({
    listingId: h.solution_id,
    title: h.solution_name ?? h.solution_id,
    categories: [],
    publisher: h.vendor_name,
  }));
}

/**
 * "Deployed on AWS" for one listing, from the MCP's search hit for its title: true / false, or
 * undefined if the listing didn't come back or the field was missing.
 */
export async function deployedOnAwsMcp(listingId: string, title: string): Promise<boolean | undefined> {
  const hit = (await search(title)).find((h) => h.solution_id === listingId);
  return typeof hit?.deployed_on_aws === "boolean" ? hit.deployed_on_aws : undefined;
}
