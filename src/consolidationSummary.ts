/**
 * Consolidation math: splits the portfolio's ACV into Confirmed / Pending selection /
 * Not-on-Marketplace, works out each app's renewal timing, and ranks the apps.
 *
 * This used to be a Python + pandas service (analytics/service.py) called over
 * JSON-over-stdio. It's plain TypeScript now so the bundle needs only Node.js —
 * installing Python was the hardest setup step on customers' Windows laptops. The
 * output (analytics-results.json) is unchanged, field for field.
 */

const BUCKET_90D = 90;
const BUCKET_1YR = 365;
const DAY_MS = 86_400_000;

export type RenewalBucket = "le_90d" | "le_1yr" | "later" | "lapsed" | "unknown";
const BUCKETS: RenewalBucket[] = ["le_90d", "le_1yr", "later", "lapsed", "unknown"];

const URGENCY: Record<RenewalBucket, string> = {
  le_90d: "act_now",
  le_1yr: "plan",
  later: "monitor",
  lapsed: "expired",
  unknown: "unknown",
};

export interface Selection { none?: boolean; listingId?: string }

export interface SummaryPayload {
  as_of: string;
  generated_from?: string;
  /** The source's PortfolioFieldCapabilities; only `renewalDate` matters here. */
  capabilities?: object;
  matches?: any[];
  selections?: Record<string, Selection | undefined>;
}

export interface Summary {
  as_of: string;
  generated_from: string | null;
  counts: { confirmed: number; needs_selection: number; not_on_marketplace: number };
  confirmed_usd: number;
  pending_usd: number;
  not_on_marketplace_usd: number;
  renewing_90d_confirmed_usd?: number;
  renewal_buckets: Record<string, Record<string, { count: number; usd: number }>>;
  apps: Array<Record<string, any>>;
  capabilities: object;
  disclaimer: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (rows: { spend: number }[]) => rows.reduce((s, r) => s + r.spend, 0);

/**
 * Fold a buyer's selection (from selections.json) into an effective status:
 *   {"none": true}       -> not_on_marketplace (buyer says none of these fit)
 *   {"listingId": "..."} -> confirmed, resolved to that catalog product
 * No selection -> keep the matcher's status; if it pre-filled `auto`, expose it as
 * `resolved` but leave the status as-is (auto is a suggestion, not a confirmation).
 */
function applySelection(match: any, selection: Selection | undefined): [string, any] {
  const status = match.status ?? null;
  if (selection) {
    if (selection.none) return ["not_on_marketplace", null];
    const lid = selection.listingId;
    if (lid) {
      const cand = (match.candidates ?? []).find((c: any) => c?.listingId === lid);
      return ["confirmed", { listingId: lid, title: cand?.title ?? null }];
    }
  }
  return [status, match.auto ?? null];
}

/** App-level renewal bucket from the soonest upcoming contract end date. */
function renewal(m: any, asOf: number, renewalKnown: boolean): [string | null, RenewalBucket, number | null] {
  const renewals = (m.renewals ?? [])
    .map((r: unknown) => (r == null ? NaN : Date.parse(String(r))))
    .filter((t: number) => !Number.isNaN(t));
  if (!renewalKnown || renewals.length === 0) return [null, "unknown", null];
  const upcoming = renewals.filter((t: number) => t >= asOf);
  if (upcoming.length) {
    const next = Math.min(...upcoming);
    const days = Math.floor((next - asOf) / DAY_MS);
    const bucket: RenewalBucket = days <= BUCKET_90D ? "le_90d" : days <= BUCKET_1YR ? "le_1yr" : "later";
    return [new Date(next).toISOString().slice(0, 10), bucket, days];
  }
  return [null, "lapsed", Math.floor((Math.max(...renewals) - asOf) / DAY_MS)];
}

/**
 * Vendor-first consolidation math. Splits portfolio ACV into three buckets that are
 * never summed:
 *   Confirmed          — a specific product is settled (tight/sole auto match OR a buyer selection).
 *   Pending selection  — vendor is on Marketplace but the buyer hasn't yet picked which product (or 'none').
 *   Not on Marketplace — vendor absent, or buyer marked 'none of these'.
 */
export function consolidationSummary(payload: SummaryPayload): Summary {
  const asOf = Date.parse(`${payload.as_of.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(asOf)) throw new Error(`Invalid as-of date "${payload.as_of}" (expected YYYY-MM-DD).`);
  const asOfDate = new Date(asOf).toISOString().slice(0, 10);
  const caps = payload.capabilities ?? {};
  const matches = payload.matches ?? [];
  const selections = payload.selections ?? {};
  const renewalKnown = !!(caps as { renewalDate?: boolean }).renewalDate;

  const rows = matches.map((m) => {
    const [status, resolved] = applySelection(m, selections[m.app]);
    const [nextRenewal, bucket, days] = renewal(m, asOf, renewalKnown);
    return {
      app: m.app ?? null,
      vendor: m.vendor ?? null,
      sellerName: m.sellerName ?? null,
      status,
      granularity: m.granularity ?? null,
      spend: Number(m.annualSpend) || 0,
      seats: Number(m.seats) || null,
      candidateCount: (m.candidates ?? []).length,
      candidates: m.candidates ?? [],
      resolved,
      next_renewal: nextRenewal,
      days_to_renewal: days,
      renewal_bucket: bucket,
      renewal_urgency: URGENCY[bucket],
      rationale: m.rationale ?? null,
      matchedBy: m.matchedBy ?? null,
      lineItemDescriptions: m.lineItemDescriptions || [],
    };
  });

  if (!rows.length) {
    return {
      as_of: asOfDate,
      generated_from: payload.generated_from ?? null,
      counts: { confirmed: 0, needs_selection: 0, not_on_marketplace: 0 },
      confirmed_usd: 0,
      pending_usd: 0,
      not_on_marketplace_usd: 0,
      renewal_buckets: {},
      apps: [],
      capabilities: caps,
      disclaimer: "No apps to analyze.",
    };
  }

  const confirmed = rows.filter((r) => r.status === "confirmed");
  const pending = rows.filter((r) => r.status === "needs_selection");
  const notMp = rows.filter((r) => r.status === "not_on_marketplace");

  const bucketsFor = (sub: typeof rows) =>
    Object.fromEntries(
      BUCKETS.map((b) => {
        const s = sub.filter((r) => r.renewal_bucket === b);
        return [b, { count: s.length, usd: round2(sum(s)) }];
      }),
    );

  // Ranking: confirmed → pending → not_on_marketplace; act_now first; ACV desc. (Stable,
  // so ties keep the matcher's order, as before.)
  const statusRank: Record<string, number> = { confirmed: 0, needs_selection: 1, not_on_marketplace: 2 };
  const urgRank: Record<string, number> = { act_now: 0, plan: 1, monitor: 2, expired: 3, unknown: 4 };
  const rank = (v: number | undefined) => (v === undefined ? Infinity : v);
  const apps = [...rows]
    .sort(
      (a, b) =>
        rank(statusRank[a.status]) - rank(statusRank[b.status]) ||
        urgRank[a.renewal_urgency] - urgRank[b.renewal_urgency] ||
        b.spend - a.spend,
    )
    .map((r) => ({ ...r, spend: round2(r.spend) }));

  let disclaimer =
    "ACV (annual contract value) comes from each application's current contracts: a contract's line items, minus one-time fees such as professional services, divided by its term in years. Expired contracts and ones already renewed are left out. It can differ from the ACV shown in SaaS Manager. It is split into Confirmed / Pending selection / Not-on-Marketplace and never summed. " +
    "Pending = vendor is on Marketplace but the buyer hasn't yet confirmed which product (or 'none'); " +
    "those dollars firm up only as selections are made. ";
  disclaimer += renewalKnown
    ? "Renewal buckets are app-level: an app's full ACV is attributed to its soonest upcoming renewal (per-contract splits not carried through)."
    : "No renewal dates from this source; timing buckets are 'unknown'.";

  return {
    as_of: asOfDate,
    generated_from: payload.generated_from ?? null,
    counts: { confirmed: confirmed.length, needs_selection: pending.length, not_on_marketplace: notMp.length },
    confirmed_usd: round2(sum(confirmed)),
    pending_usd: round2(sum(pending)),
    not_on_marketplace_usd: round2(sum(notMp)),
    renewing_90d_confirmed_usd: round2(sum(confirmed.filter((r) => r.renewal_bucket === "le_90d"))),
    renewal_buckets: { confirmed: bucketsFor(confirmed), pending: bucketsFor(pending) },
    apps,
    capabilities: caps,
    disclaimer,
  };
}
