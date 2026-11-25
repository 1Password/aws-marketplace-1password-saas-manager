/**
 * Vendor-first, buyer-confirmed matching (replaces the SKU-asserting scorer).
 *
 * Per portfolio app we DON'T guess a specific listing. Instead:
 *   1. Resolve the vendor's Marketplace seller and pull its full catalog.
 *   2. Detect granularity — does the app name carry product detail beyond
 *      the vendor brand? ("Acme" = no; "Acme Suite" = yes.)
 *   3. Decide a state the buyer (or a UI) resolves:
 *        not_on_marketplace — vendor has no Marketplace seller/listings.
 *        confirmed          — a single unambiguous product (tight title match,
 *                             or the vendor's sole listing); pre-filled, still
 *                             overridable to "none".
 *        needs_selection    — show the vendor's catalog; buyer picks one, or "none".
 *   4. Pending refinement (layered on the vendor match) — for a needs_selection
 *      app, the contract line items (lineItems[].description) are evidence for
 *      WHICH of the vendor's listings the buyer has: a line mentioning what sets a
 *      listing apart ("Enterprise plan" vs {Acme Enterprise, Acme Platform})
 *      confirms it; lines pointing at several listings narrow the choice.
 *
 * We never assert a SKU we can't verify. "none of these" is always available
 * downstream (the buyer's product may not be on Marketplace at all).
 *
 * Candidate lists come from Discovery's PUBLISHER filter (complete catalog);
 * action URLs are fetched lazily only for the chosen product (see resolve step).
 */

import { resolveSeller, listVendorProducts, type VendorProduct, type SellerMatchStrength } from "./discovery.js";

export interface AppInput {
  name: string;
  vendor?: string;
  descriptor?: string;
  annualSpend?: number;
  seats?: number;
  renewals?: string[];
  /** Product-bearing contract line-item descriptions — narrow pending candidates. */
  lineItemDescriptions?: string[];
}

export type MatchStatus = "confirmed" | "needs_selection" | "not_on_marketplace";

export interface VendorMatch {
  app: string;
  vendor?: string;
  annualSpend?: number;
  seats?: number;
  renewals?: string[];
  vendorOnMarketplace: boolean;
  sellerId?: string;
  sellerName?: string;
  /** How confidently the seller name matches the vendor — gates auto-confirm. */
  sellerMatch?: SellerMatchStrength;
  granularity: boolean;
  status: MatchStatus;
  /** A single product we pre-fill (tight/sole match). Always overridable. */
  auto: { listingId: string; title: string } | null;
  /** The vendor's Marketplace catalog — the buyer's choices for needs_selection. */
  candidates: VendorProduct[];
  /** What settled or narrowed the match: the app name, or a contract line item. */
  matchedBy?: "app_name" | "line_item";
  /** Contract line-item descriptions consulted for pending refinement, if any. */
  lineItemDescriptions?: string[];
  rationale: string;
}

// Edition/tier words that are too generic to identify a product on their own —
// "Enterprise" alone can tight-match an unrelated listing that also says
// "Enterprise" (e.g. Acme Enterprise → "Globex Builder Enterprise"). A tight match on
// edition words ONLY is trusted for auto-confirm only if the listing title also
// carries the vendor brand (so "Acme Enterprise" → "Acme Enterprise" is fine).
const EDITION = new Set([
  "enterprise", "premium", "pro", "professional", "ultimate", "business",
  "starter", "standard", "basic", "plus", "advanced", "team", "essentials",
]);

// Corporate suffixes / generic words that shouldn't count as product granularity.
const STOP = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
  "the", "and", "gmbh", "srl", "pty", "sa", "ag", "plc", "pbc", "software",
  "technologies", "technology", "systems", "solutions", "labs", "cloud",
  "platform", "services", "app", "apps", "server", "for", "of", "by", "com",
]);

function toks(s: string | undefined): string[] {
  if (!s) return [];
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}
function titleTokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean));
}

// Contract-line noise that never identifies a product ("Annual subscription - 100 users").
const LINE_NOISE = new Set([
  "subscription", "subscriptions", "annual", "annually", "monthly", "yearly", "year", "years",
  "month", "months", "unit", "units", "seat", "seats", "user", "users", "license", "licenses",
  "licence", "licences", "renewal", "renew", "term", "order", "form", "orderform", "msa",
  "purchase", "po", "contract", "agreement", "fee", "fees", "invoice", "total", "qty", "quantity",
  "extra", "usage", "overage", "plan", "addon", "with", "service",
]);

// STOP words that still name a product family in a listing title.
const PRODUCT_WORDS = new Set(["cloud", "platform", "server", "services", "app", "apps", "software"]);

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Pending refinement — layered on the vendor match. The vendor match has already
 * produced `pool` (the vendor's listings for this app); the contract line items are
 * EVIDENCE for which of those listings the buyer has.
 *
 * Each listing is reduced to its DISTINCTIVE tokens — the title words that tell it
 * apart from the rest of the pool (brand, contract noise, and words every listing
 * shares like "Acme" are dropped): {Acme Enterprise, Acme Platform} →
 * {enterprise}, {platform}. Per line item:
 *   • DECISIVE when the line clearly names one listing — either it mentions all of
 *     a listing's distinctive tokens and nothing else in it points at another
 *     listing ("Extra usage units, Enterprise plan" → Acme Enterprise), or every
 *     product word in it belongs to that one listing ("Acme Vipr" → Vipr Pro).
 *   • PARTIAL when it shares words with listings without clearly naming one
 *     ("Income Tax Suite" vs "Indirect Tax Determination"). Too weak to
 *     narrow on, but it does block a confirmation it disagrees with.
 *   • IGNORED when it points at no listing ("Claude Code", "October (2026)").
 * One decisive listing, no partial line pointing elsewhere → confirm. Otherwise,
 * if any line is decisive, narrow to the listings the lines point at (decisive and
 * partial — "Tracker", "Guard"). With no decisive line the candidate list is left alone.
 */
function matchLineItems(
  pool: VendorProduct[], descriptions: string[], brandToks: Set<string>, anchorToks: Set<string>,
): { hits: VendorProduct[]; signals: string[]; decisive: boolean } | null {
  // Unlike toks(), keep product words ("cloud", "platform") — here they tell listings apart.
  const sig = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) =>
    t.length > 1 && !(STOP.has(t) && !PRODUCT_WORDS.has(t)) && !brandToks.has(t) && !LINE_NOISE.has(t)
    && !/^\d+$/.test(t) && !/^\d+(yr|yrs|y|mo|mos|m)$/.test(t));
  const titleToks = pool.map((c) => new Set(sig(c.title)));
  const shared = new Set([...(titleToks[0] ?? [])].filter((t) => titleToks.every((ts) => ts.has(t))));
  // A pool of one has nothing to tell apart — its own product words are the evidence.
  const distinct = titleToks.map((ts) => [...ts].filter((t) => pool.length === 1 || !shared.has(t)));
  const squashedTitles = pool.map((c) => squash(c.title));
  // Does listing i account for line token t? (squashed: "chart" ⊂ "lucidchart")
  const covers = (i: number, t: string) => distinct[i].includes(t) || (t.length >= 3 && squashedTitles[i].includes(t) && !shared.has(t));

  const decisive = new Set<string>();
  const partial = new Set<string>();
  const signals: string[] = [];
  for (const desc of descriptions) {
    const lineToks = [...new Set(sig(desc))].filter((t) => !shared.has(t));
    const lineSquashed = squash(desc);
    const mentions = (t: string) => lineToks.includes(t) || (t.length >= 4 && lineSquashed.includes(t));
    const mentioned = distinct.map((d) => d.filter(mentions).length);
    const overlapping = pool.map((_, i) => i).filter((i) => mentioned[i] > 0);
    if (overlapping.length === 0) continue;

    // (a) a listing named in full; prefer the one the line covers most, then the most
    // exact (fewest distinctive tokens) — "Self-Managed Ultimate" → Ultimate Self-Managed.
    let full = overlapping.filter((i) => mentioned[i] === distinct[i].length);
    const maxHit = Math.max(0, ...full.map((i) => mentioned[i]));
    full = full.filter((i) => mentioned[i] === maxHit);
    const minSize = Math.min(...full.map((i) => distinct[i].length));
    full = full.filter((i) => distinct[i].length === minSize);
    const unexplained = (winners: number[]) => lineToks.filter((t) => !winners.some((i) => covers(i, t)));
    const pointsElsewhere = (winners: number[]) =>
      unexplained(winners).some((t) => pool.some((_, j) => !winners.includes(j) && covers(j, t)));
    // The line must be mostly ABOUT the listing: "Data Storage" shares only "data"
    // with "Data Hub" and is about something else. Leftover edition words describe
    // the tier within the listing ("Acme Suite - Enterprise"), so they don't count.
    const mostlyAbout = (winners: number[]) => unexplained(winners).filter((t) => !EDITION.has(t)).length < maxHit;
    // (b) the only listing the line touches, and it accounts for every product word.
    const sole = overlapping.length === 1 && lineToks.every((t) => covers(overlapping[0], t));

    let named = full.length && !pointsElsewhere(full) && mostlyAbout(full) ? full : sole ? overlapping : null;
    if (named) {
      const evidence = named.flatMap((i) => distinct[i].filter(mentions));
      // Generic product words alone ("Cloud Service") aren't evidence of a product.
      if (evidence.every((t) => PRODUCT_WORDS.has(t))) named = null;
      // Edition words alone ("Enterprise") only count on a listing carrying the brand
      // or the app's own product name — "Acme Enterprise" ≠ "Globex Enterprise".
      else if (evidence.every((t) => EDITION.has(t))
        && !named.every((i) => [...titleTokenSet(pool[i].title)].some((t) => anchorToks.has(t)))) named = null;
    }
    if (named) {
      signals.push(desc);
      named.forEach((i) => decisive.add(pool[i].listingId));
    } else overlapping.forEach((i) => partial.add(pool[i].listingId));
  }
  if (decisive.size === 0) return null;
  const isDecisive = decisive.size === 1 && [...partial].every((id) => decisive.has(id));
  // Partial lines can't narrow on their own, but once a line has narrowed, keep what
  // they point at too — dropping it would discard the buyer's own contract evidence.
  const keep = new Set([...decisive, ...partial]);
  return { hits: pool.filter((c) => keep.has(c.listingId)), signals, decisive: isDecisive };
}

/** Tokens in the app name that go BEYOND the vendor brand — the granularity signal. */
function extraTokens(appName: string, ...vendorForms: (string | undefined)[]): string[] {
  const brand = new Set(vendorForms.flatMap((v) => toks(v)));
  return toks(appName).filter((t) => !brand.has(t));
}

/** Where vendor catalogs come from. Default: the Discovery API (see discovery.ts). */
export interface CatalogSource {
  resolveSeller: typeof resolveSeller;
  listVendorProducts: typeof listVendorProducts;
}
const DISCOVERY: CatalogSource = { resolveSeller, listVendorProducts };

export async function matchVendorApp(app: AppInput, catalog: CatalogSource = DISCOVERY): Promise<VendorMatch> {
  const base = {
    app: app.name, vendor: app.vendor, annualSpend: app.annualSpend,
    seats: app.seats, renewals: app.renewals,
  };
  const notOnMp = (rationale: string): VendorMatch => ({
    ...base, vendorOnMarketplace: false, granularity: false,
    status: "not_on_marketplace", auto: null, candidates: [], rationale,
  });

  const seller = await catalog.resolveSeller(app.vendor || app.name);
  if (!seller) return notOnMp("Vendor not found as a seller on AWS Marketplace.");

  const candidates = await catalog.listVendorProducts(seller.sellerId);
  if (candidates.length === 0) return notOnMp("Vendor has no Marketplace listings.");

  const extra = extraTokens(app.name, app.vendor, seller.displayName);
  const granularity = extra.length > 0;
  const common = {
    ...base, vendorOnMarketplace: true, sellerId: seller.sellerId,
    sellerName: seller.displayName, sellerMatch: seller.strength, granularity, candidates,
  };

  // Auto-confirm requires an EXACT seller-name match. A brand-only match (the
  // seller name carries extra words, so it may be a different company sharing the
  // brand word, like "Acme" and "Acme Software") is never auto-confirmed: we show the
  // catalog and let the buyer pick, or say "none". Upholds "never silently assert".
  const canAutoConfirm = seller.strength === "exact";
  const brandCaveat = ` The Marketplace seller "${seller.displayName}" shares the brand name but may be a different company — confirm which product you use, or 'none'.`;
  const brandToks = new Set([...toks(app.vendor), ...toks(seller.displayName)]);

  // Every needs_selection exit goes through here (layer 2, after the vendor match):
  // the contract line items pick among the vendor's candidate listings. One listing
  // voted for → confirmed; several → narrowed to those. Auto-confirm keeps the name
  // path's guard — an exact seller match — since line items can't tell us whether a
  // brand-only seller is the same company.
  const pending = (pool: VendorProduct[], rationale: string): VendorMatch => {
    const descs = app.lineItemDescriptions ?? [];
    const result: VendorMatch = {
      ...common, candidates: pool, status: "needs_selection", auto: null, matchedBy: "app_name",
      lineItemDescriptions: descs.length ? descs : undefined, rationale,
    };
    const li = descs.length ? matchLineItems(pool, descs, brandToks, new Set([...brandToks, ...toks(app.name)])) : null;
    if (!li || li.hits.length === 0) return result;
    const quoted = li.signals.map((d) => `"${d}"`).join(", ");
    if (canAutoConfirm && li.decisive) {
      return { ...result, status: "confirmed", auto: { listingId: li.hits[0].listingId, title: li.hits[0].title }, matchedBy: "line_item",
        rationale: `Your contract line item (${quoted}) points to ${li.hits[0].title}; pre-selected — confirm, or mark 'none'.` };
    }
    if (li.hits.length >= pool.length) return result;
    return { ...result, candidates: li.hits, matchedBy: "line_item",
      rationale: `Your contract line items (${quoted}) narrow this to ${li.hits.length} of ${pool.length} listings — confirm which one you use, or 'none'.`
        + (canAutoConfirm ? "" : brandCaveat) };
  };

  if (granularity) {
    // Tight match = a listing whose title contains ALL the app's extra tokens.
    const tight = candidates.filter((c) => {
      const t = titleTokenSet(c.title);
      return extra.every((tok) => t.has(tok));
    });
    // Guard: if the product's distinguishing tokens are ALL edition words, only
    // auto-confirm when the single tight listing also carries the vendor brand —
    // otherwise it's likely a different product that merely shares "Enterprise".
    const onlyEdition = extra.every((t) => EDITION.has(t));
    const titleHasBrand = tight.length === 1 && [...titleTokenSet(tight[0].title)].some((t) => brandToks.has(t));
    if (canAutoConfirm && tight.length === 1 && (!onlyEdition || titleHasBrand)) {
      return { ...common, status: "confirmed", auto: { listingId: tight[0].listingId, title: tight[0].title }, matchedBy: "app_name",
        rationale: `Your data names a specific product ("${extra.join(" ")}") with one matching Marketplace listing.` };
    }
    // When the product name tight-matches some listings, narrow the buyer's choices
    // to just that product family (not the whole vendor catalog). If nothing tight-
    // matches, fall back to the full catalog (the named product may not be listed).
    return pending(tight.length > 0 ? tight : candidates,
      (tight.length > 1
        ? `Your product ("${extra.join(" ")}") matches several of the vendor's listings — confirm which one you use.`
        : "Your product name doesn't tightly match a single listing — choose from the vendor's catalog, or 'none'.")
        + (canAutoConfirm ? "" : brandCaveat));
  }

  // No granularity: the source has only the vendor brand.
  if (canAutoConfirm && candidates.length === 1) {
    return { ...common, status: "confirmed", auto: { listingId: candidates[0].listingId, title: candidates[0].title }, matchedBy: "app_name",
      rationale: "The vendor lists a single Marketplace product; pre-selected — confirm, or mark 'none'." };
  }
  return pending(candidates,
    (candidates.length === 1
      ? "One Marketplace listing found for this vendor name — confirm it's your product, or 'none'."
      : "Your data has only the vendor name; choose which of the vendor's products you use, or 'none'.")
      + (canAutoConfirm ? "" : brandCaveat));
}
