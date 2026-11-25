/**
 * AWS Marketplace Agreement API client.
 *
 * The Agreements tier answers: "which of my portfolio apps do I ALREADY have a
 * Marketplace agreement for?" Those are already consolidated — the buyer should
 * focus consolidation effort on the rest.
 *
 * Real mode calls the Agreement API through the AWS SDK with the user's own profile
 * (awsClients.ts: us-east-1 only, endpoint overrides ignored; no AWS CLI needed). Verified live shape (2026-08-25,
 * a ReadOnly Marketplace account): search-agreements → agreementViewSummaries[];
 * describe-agreement → { estimatedCharges:{currencyCode,agreementValue},
 * proposalSummary:{resources:[{id,type}],offerId}, start/endTime, status,
 * proposer.accountId }. Each resource `id` is the product id — either a Catalog
 * `prod-*` or a Discovery UUID — and Discovery `get-product(id)` RESOLVES both to
 * a productName + sellerProfileId + productId (VERIFIED 2026-09-04). So the real
 * join is: agreement resource id → get-product → match that product to a confirmed
 * portfolio app (exact product-UUID, else normalized product-name). The assumed
 * synthesizer below is retained only as an opt-in demo (AGREEMENTS_DEMO_ASSUMED=1)
 * for when the connected account has no agreements overlapping its portfolio.
 */

import { SearchAgreementsCommand, DescribeAgreementCommand } from "@aws-sdk/client-marketplace-agreement";
import { agreementClient } from "./awsClients.js";

export interface AgreementSummary {
  agreementId: string;
  status: string;
  startTime?: string;
  endTime?: string;
  acceptanceTime?: string;
  agreementType?: string;
  proposer?: { accountId?: string };
  proposalSummary?: { resources?: { id: string; type: string }[]; offerId?: string };
}

const iso = (d?: Date) => (d instanceof Date && !isNaN(+d) ? d.toISOString() : undefined);

// PartyType must be paired with another filter or the API rejects it.
const BUYER_FILTERS = [
  { name: "PartyType", values: ["Acceptor"] },
  { name: "AgreementType", values: ["PurchaseAgreement"] },
];

/** Live search of the buyer's PurchaseAgreements as the Acceptor (read-only). */
export async function searchRealAgreements(maxResults = 50): Promise<AgreementSummary[]> {
  const r = await agreementClient().send(new SearchAgreementsCommand({ catalog: "AWSMarketplace", filters: BUYER_FILTERS, maxResults }));
  return (r.agreementViewSummaries ?? []).map((a) => ({
    agreementId: String(a.agreementId ?? ""),
    status: String(a.status ?? ""),
    startTime: iso(a.startTime),
    endTime: iso(a.endTime),
    acceptanceTime: iso(a.acceptanceTime),
    agreementType: a.agreementType,
    proposer: { accountId: a.proposer?.accountId },
    proposalSummary: {
      offerId: a.proposalSummary?.offerId,
      resources: (a.proposalSummary?.resources ?? []).map((x) => ({ id: String(x.id ?? ""), type: String(x.type ?? "") })),
    },
  }));
}

export interface AgreementDetail {
  agreementId: string;
  status: string;
  startTime?: string;
  endTime?: string;
  currency?: string;
  committedUsd?: number;
  resources: { id: string; type: string }[];
}

/** Full detail for one agreement (adds estimatedCharges — the committed value). */
export async function describeAgreement(agreementId: string): Promise<AgreementDetail> {
  const a = await agreementClient().send(new DescribeAgreementCommand({ agreementId }));
  const val = a.estimatedCharges?.agreementValue;
  return {
    agreementId,
    status: String(a.status ?? ""),
    startTime: iso(a.startTime),
    endTime: iso(a.endTime),
    currency: a.estimatedCharges?.currencyCode,
    committedUsd: val != null && val !== "" ? Number(val) : undefined,
    resources: (a.proposalSummary?.resources ?? []).map((x) => ({ id: String(x.id ?? ""), type: String(x.type ?? "") })),
  };
}

// ── Join: resolved agreement product → confirmed portfolio app ──────────────────
export interface AppForJoin { app: string; vendor?: string; productUuid?: string; productTitle?: string }
export interface ResolvedAgreementProduct { productId: string; productName?: string }

const normName = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Match a resolved Agreement product to a confirmed portfolio app. Exact Discovery
 * product-id (UUID) first; else normalized product-name equality against the app's
 * resolved Marketplace title (handles the `prod-*`-vs-UUID namespace split, where the
 * only shared signal is the product name). Returns the app + how it matched, or null.
 */
export function matchAgreementProductToApp(
  product: ResolvedAgreementProduct,
  apps: AppForJoin[],
): { app: AppForJoin; matchedBy: "product-id" | "product-name" } | null {
  const byId = apps.find((a) => a.productUuid && a.productUuid === product.productId);
  if (byId) return { app: byId, matchedBy: "product-id" };
  const pn = normName(product.productName);
  if (pn) {
    const byName = apps.find((a) => normName(a.productTitle) === pn);
    if (byName) return { app: byName, matchedBy: "product-name" };
  }
  return null;
}

// ── Assumed-data synthesis (prototype) ──────────────────────────────────────
// The buyer's test account has no real agreements matching the portfolio, so we
// synthesize a few that DO — mirroring the real describe-agreement shape — to
// show the "already on Marketplace" nuance in the report. Clearly flagged assumed.

/** Small deterministic hash → hex (no RNG, so re-runs are idempotent). */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AssumedAgreement {
  app: string;
  vendor?: string;
  onMarketplace: true;
  agreementId: string;
  status: "ACTIVE";
  startTime: string;
  endTime: string;
  committedUsd: number;
  currency: "USD";
  productId: string;
  offerId: string;
  proposerAccountId: string;
  assumed: true;
}

/**
 * Synthesize an assumed ACTIVE agreement for one portfolio app. Committed value
 * ≈ the app's annual spend; term is a 1-year window around the demo "as of" date.
 */
export function assumedAgreementFor(
  app: { app: string; vendor?: string; annualSpend?: number },
  asOf: string,
): AssumedAgreement {
  const h = hash(app.app);
  const start = addDays(asOf, -120); // started ~4 months before "today"
  return {
    app: app.app,
    vendor: app.vendor,
    onMarketplace: true,
    agreementId: `agmt-${h}${h.slice(0, 4)}`,
    status: "ACTIVE",
    startTime: start,
    endTime: addDays(start, 365),
    committedUsd: Math.round(app.annualSpend ?? 0),
    currency: "USD",
    productId: `prod-${h}`,
    offerId: `offer-${h}`,
    proposerAccountId: "123456789012", // illustrative
    assumed: true,
  };
}
