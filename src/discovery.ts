/**
 * AWS Marketplace Discovery API client — used when the customer has set an AWS profile
 * (discoveryAuth.ts); otherwise matching uses the AWS Marketplace MCP (catalog.ts).
 *
 * Discovery is a SigV4-signed AWS API; calls go through the AWS SDK for
 * JavaScript, which signs them — no AWS CLI install needed on the buyer's machine.
 *
 * Every call is cached on disk under .cache/discovery/ for CACHE_TTL_DAYS, so re-runs are
 * quick and the enrichment pass is resumable, while new listings still show up within a week.
 *
 * Verified 2026-08-20 (a ReadOnly Marketplace account): Discovery hits the real
 * prod catalog. Discovery `listingId` == the MCP `prodview-*` id, so it joins onto
 * our existing report rows. Only the three calls the dashboard needs are made:
 * search-listings, get-listing, get-product.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  GetListingCommand,
  GetProductCommand,
  SearchListingsCommand,
} from "@aws-sdk/client-marketplace-discovery";
import { discoveryAuth } from "./discoveryAuth.js";
import { awsErrorText } from "./awsClients.js";

const CACHE_DIR = ".cache/discovery";
/** How long a cached catalog response is reused before it's fetched again. */
export const CACHE_TTL_DAYS = 7;
export const isFresh = (file: string) => existsSync(file) && Date.now() - statSync(file).mtimeMs < CACHE_TTL_DAYS * 86_400_000;

type Op = "search-listings" | "get-listing" | "get-product";

function cacheKey(op: string, input: object): string {
  return createHash("sha1").update(op + "\0" + JSON.stringify(input)).digest("hex").slice(0, 16);
}

/** One SDK call; paged search results are followed up to `maxItems`. */
async function send(op: Op, input: any, maxItems: number): Promise<any> {
  const { client } = discoveryAuth();
  switch (op) {
    case "get-listing":
      return client.send(new GetListingCommand(input));
    case "get-product":
      return client.send(new GetProductCommand(input));
    case "search-listings": {
      const key = "listingSummaries";
      const items: any[] = [];
      let first: any;
      let nextToken: string | undefined;
      do {
        const page: any = await client.send(new SearchListingsCommand({ ...input, nextToken }));
        first ??= page;
        items.push(...(page[key] ?? []));
        nextToken = page.nextToken;
      } while (nextToken && items.length < maxItems);
      const { $metadata, nextToken: _t, ...rest } = first ?? {};
      return { ...rest, [key]: items.slice(0, maxItems) };
    }
  }
}

/** Run one Discovery call, cached on disk by (op, input). */
async function aws(op: Op, input: Record<string, unknown>, maxItems = Infinity): Promise<any> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = `${CACHE_DIR}/${op}-${cacheKey(op, { ...input, maxItems: String(maxItems) })}.json`;
  if (isFresh(file)) return JSON.parse(readFileSync(file, "utf8"));
  let out: any;
  try {
    out = await send(op, input, maxItems);
  } catch (e) {
    // Fixed text by error name and status; the raw AWS message never reaches the agent.
    throw new Error(`${op} failed: ${awsErrorText(e, discoveryAuth().describe)}`);
  }
  const { $metadata, ...parsed } = out ?? {};
  writeFileSync(file, JSON.stringify(parsed));
  return parsed;
}

export interface PriceTier {
  label: string;
  description?: string;
  unit: string;
  price: number;
}
export interface PriceSummary {
  found: boolean;
  listingId?: string;
  offerId?: string;
  listingName?: string;
  publisher?: string;
  model?: "contract" | "usage" | "other";
  /**
   * How the price scales, inferred from the dimension descriptions:
   *   "per-unit" — per seat/user/host (multiply by seats for a total)
   *   "flat"     — a capacity tier (e.g. "up to 100k MAU"); do NOT multiply
   *   "usage"    — usage-based metering ($/unit consumed)
   * Drives whether seat-adjusted math is valid for this product.
   */
  priceKind?: "per-unit" | "flat" | "usage";
  currency?: string;
  term?: string; // e.g. "P12M"
  tiers?: PriceTier[];
  annualMin?: number;
  annualMax?: number;
  /**
   * True only when the price is genuinely an annual figure comparable to the
   * buyer's yearly spend: a CONTRACT rate card with a P12M (1-year) selector.
   * Usage-based ($/unit) and non-annual terms are NOT comparable and get false —
   * the report must not present those as an annual list price.
   */
  annualComparable?: boolean;
}

export async function searchListings(text: string, max = 3): Promise<any[]> {
  const d = await aws("search-listings", { searchText: text }, max);
  return d.listingSummaries ?? [];
}

export interface VendorProduct {
  listingId: string;
  title: string;
  categories: string[];
  publisher?: string;
}

const normV = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Legal-entity suffixes stripped before comparing names (so "Okta" == "Okta Inc").
// NOTE: descriptive words like "software"/"systems"/"security" are deliberately
// NOT stripped — they're what distinguish a different company sharing a brand
// word (e.g. "Acme" tax software vs "Acme Software" 3D tools).
const LEGAL = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
  "gmbh", "srl", "pty", "sa", "ag", "plc", "bv", "nv", "pbc",
]);

/** Significant name tokens; drops legal suffixes and tokens shorter than minLen. */
function nameTokens(s: string | undefined, minLen = 1): string[] {
  return normV(s).split(" ").filter((t) => t.length >= minLen && !LEGAL.has(t));
}

export type SellerMatchStrength = "exact" | "brand";
export interface SellerResolution {
  sellerId: string;
  displayName: string;
  strength: SellerMatchStrength;
}

/**
 * Resolve the Marketplace seller whose display name matches a portfolio vendor.
 * The PUBLISHER filter keys off sellerProfileId (NOT the display name — verified),
 * so we keyword-search the vendor and pick the best-matching publisher.
 *
 * Returns a match STRENGTH so the caller can decide whether to auto-confirm:
 *   "exact" — the seller's name (minus legal suffixes) equals the vendor's.
 *   "brand" — they share a distinctive token (len>=3) but the seller carries
 *             extra words, so it MAY be a different company using the same brand
 *             word (e.g. "Acme" tax vs "Acme Software" 3D tools; "Globex" vs
 *             "Globex IT"). Plausible but must be buyer-confirmed — never auto.
 * No shared distinctive token -> not a match. This kills the fuzzy-substring
 * noise the old scorer produced (one vendor matched to an unrelated seller sharing a
 * word fragment, several apps to the same short seller name).
 */
export async function resolveSeller(vendorName: string): Promise<SellerResolution | undefined> {
  const hits = await searchListings(vendorName, 10);
  const wantExact = nameTokens(vendorName).sort(); // keep short tokens for equality
  const wantBrand = new Set(nameTokens(vendorName, 3)); // len>=3 for overlap
  const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

  // Rank: 2 = exact, 1 = brand, 0 = no match. Hits are relevance-ordered, so the
  // first at the top rank wins (stable — no re-sort needed).
  let best: { sellerId: string; displayName: string; rank: number } | undefined;
  for (const h of hits) {
    const sellerId = h.publisher?.sellerProfileId as string | undefined;
    const displayName = h.publisher?.displayName as string | undefined;
    if (!sellerId || !displayName) continue;
    let rank = 0;
    if (wantExact.length && setEq(wantExact, nameTokens(displayName).sort())) rank = 2;
    else if (nameTokens(displayName, 3).some((t) => wantBrand.has(t))) rank = 1;
    if (rank > (best?.rank ?? 0)) best = { sellerId, displayName, rank };
  }
  if (!best) return undefined;
  return { sellerId: best.sellerId, displayName: best.displayName, strength: best.rank === 2 ? "exact" : "brand" };
}

/** List a vendor's full Marketplace catalog via the PUBLISHER (sellerId) filter. */
export async function listVendorProducts(sellerId: string): Promise<VendorProduct[]> {
  const d = await aws("search-listings", { filters: [{ filterType: "PUBLISHER", filterValues: [sellerId] }] }, 200);
  const listings = d.listingSummaries ?? [];
  // Dedupe by listingId (search can repeat a listing across fulfillment options).
  const seen = new Map<string, VendorProduct>();
  for (const l of listings) {
    if (!l.listingId || seen.has(l.listingId)) continue;
    seen.set(l.listingId, {
      listingId: l.listingId,
      title: l.listingName,
      categories: (l.categories ?? []).map((c: any) => c.displayName).filter(Boolean),
      publisher: l.publisher?.displayName,
    });
  }
  return [...seen.values()];
}
export async function getListing(listingId: string): Promise<any> {
  return aws("get-listing", { listingId });
}

export interface DiscoveryProduct {
  productId: string;
  productName?: string;
  sellerProfileId?: string;
  sellerName?: string;
  deployedOnAws?: string;
}
/**
 * Resolve a product by its Discovery/Catalog id (accepts BOTH `prod-*` and UUID
 * forms — an Agreement's resource id is one of these). Returns null if the product
 * isn't found (delisted / unknown) so a caller can skip it. Cached; best-effort
 * (never throws, so one bad id can't break an enrichment pass).
 */
export async function getProduct(productId: string): Promise<DiscoveryProduct | null> {
  try {
    const p = await aws("get-product", { productId });
    if (!p?.productId) return null;
    return {
      productId: p.productId,
      productName: p.productName,
      sellerProfileId: p.manufacturer?.sellerProfileId,
      sellerName: p.manufacturer?.name ?? undefined,
      deployedOnAws: p.deployedOnAws,
    };
  } catch {
    return null;
  }
}
