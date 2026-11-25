/**
 * 1Password SaaS Manager provider — self-contained: connection, ingest,
 * and the data adapter.
 *
 * Data model (SaaS Manager public API):
 *   • Contracts carry `vendorName` (+ spend, renewal, seats via lineItems) and — once
 *     the API ships it — `app: { id, name, instanceName?, globalAppId? }`, the
 *     **Main application** the buyer attributed the contract to in the SaaS Manager UI.
 *   • Apps live in a SEPARATE resource with { id, name, vendor.{id,name}, mainCategory }.
 * So ingestion is a two-source JOIN — by `app.id` when present, otherwise by an explicit
 * attribution file, otherwise by vendor name — aggregated by APPLICATION. One contract
 * → one application row, all its line items summed in. The app record contributes the
 * display NAME (what the UI shows), the descriptor, and adoption.
 *
 * This module is the ONLY place that mentions 1Password SaaS Manager. Everything
 * downstream sees the normalized PortfolioApp via the adapter.
 *
 * Smoke test:  SAAS_PROVIDER=1password node --env-file=.env --import tsx src/providers/1password.ts [limit]
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_HOST, OnePasswordClient, loadCredentials, missingCredentialsMessage } from "./onePasswordClient.js";
import type { PortfolioApp, PortfolioAppAgg, AdoptionMetrics, NoContractApp } from "../types.js";
import type { SaaSProvider, PortfolioPull } from "../provider.js";
import { safeErrorMessage } from "../untrusted.js";

// ── normalize helpers (self-contained so the provider ships alone) ──
function pick(rec: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null && rec[k] !== "") return rec[k];
  }
  return undefined;
}
function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const LEGAL = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
  "gmbh", "srl", "pty", "sa", "ag", "plc", "bv", "nv", "lp", "llp", "pbc",
]);

/** Squash a name to comparable form: lowercase, alphanumerics only ("Acme Chart" → "acmechart"). */
function squash(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Normalize a company name to a join key: lowercase, drop punctuation + legal suffixes. */
function vendorKey(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t))
    .join(" ")
    .trim();
}

// Contract-noise words that don't identify a product — used to decide whether a
// line-item description actually names a product vs. a generic subscription line.
const GENERIC_DESC = new Set([
  "subscription", "subscriptions", "annual", "annually", "monthly", "yearly",
  "unit", "units", "seat", "seats", "user", "users", "license", "licenses",
  "licence", "renewal", "term", "orderform", "msa", "purchaseorder",
  "genericcontract", "contract",
]);

/** An app record from GET /api/apps/v1, indexed for the joins. */
interface VendorAppRef { name: string; category?: string }

/**
 * Hand-supplied contract -> Main application map (see config/app-attribution.json for why).
 * SaaS Manager requires a Main application on every contract in its UI; until the API
 * exposes it as `app` on the contract, the buyer copies it here. Consulted only for
 * contracts whose API payload has no `app`, and it OVERRIDES the heuristic below.
 * Keyed by contract id; a null value means "this contract has no Main application set".
 */
interface AttributionEntry { app: string | null }
type AttributionOverrides = Map<string, AttributionEntry | null>;

function loadAttributionOverrides(): AttributionOverrides {
  const file = process.env.APP_ATTRIBUTION_FILE ?? "config/app-attribution.json";
  const map: AttributionOverrides = new Map();
  if (!existsSync(file)) return map;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, v] of Object.entries(raw.byContractId ?? {}) as [string, any][]) {
      if (v === null) map.set(id, null);
      else if (typeof v === "string") map.set(id, { app: v }); // legacy: bare app name
      else if (v && typeof v === "object") map.set(id, { app: v.app ?? null });
    }
  } catch (e) {
    console.error(`  ! ignoring ${file} (unreadable or invalid JSON).`);
  }
  return map;
}

/**
 * HEURISTIC ATTRIBUTION — last resort, used only when a contract has neither an API
 * `app` nor an entry in the attribution file. Reconstructs the Main application from
 * the vendor's app records: pick the one the contract's own text names, else the
 * vendor's most-adopted app. Measured at 3 of 8 wrong on real data (the line item
 * names the SKU — "Live licenses", "Acme Chart" — while the Main application is
 * usually the parent app), which is exactly why the API field and the file win.
 *
 * Scored per contract (not per line item) because attribution is a contract-level
 * act by the buyer: all of a contract's line items therefore land on one app.
 *
 * Ranking, strongest first:
 *   1. squashed containment — the contract text contains the app name, or vice versa
 *      ("Acme Analytics (2026-2027)" → "Acme Analytics")
 *   2. token overlap beyond the vendor brand and generic contract words
 *   3. fewer unmatched extra tokens in the app name (prefers the more exact product)
 *   4. higher adoption (provisioned users) — also the sole tiebreak when the
 *      contract text is purely generic ("LICENSE" → the vendor's most-used app, not a rarely used one)
 */
/**
 * True when a line-item description names something beyond generic contract noise
 * ("Annual subscription", "100 users", "LICENSE") — i.e. it may identify a product.
 */
function isProductDescription(desc: string, vendor: string | undefined): boolean {
  const brand = new Set(vendorKey(vendor).split(" ").filter(Boolean));
  return desc.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .some((t) => t.length > 1 && !/^\d+$/.test(t) && !brand.has(t) && !GENERIC_DESC.has(t));
}

function attributeContractToApp(
  text: string,
  vendor: string | undefined,
  apps: VendorAppRef[],
  adoptionByApp: Map<string, AdoptionMetrics>,
): { app: VendorAppRef; basis: "name" | "adoption" } | undefined {
  if (apps.length === 0) return undefined;
  const provisioned = (a: VendorAppRef) => adoptionByApp.get(a.name.toLowerCase())?.provisionedUsers ?? 0;
  if (apps.length === 1) return { app: apps[0], basis: "name" };

  const brand = new Set(vendorKey(vendor).split(" ").filter(Boolean));
  const sig = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
      .filter((t) => t.length > 1 && !brand.has(t) && !GENERIC_DESC.has(t));
  const textTokens = new Set(sig(text));
  const textSquashed = squash(text);

  let best: { app: VendorAppRef; contain: number; overlap: number; extra: number; users: number } | undefined;
  for (const app of apps) {
    const appSquashed = squash(app.name);
    // Containment only counts on a substantive name (avoids a 1-2 char accident).
    const contain =
      appSquashed.length >= 4 && (textSquashed.includes(appSquashed) || appSquashed.includes(textSquashed)) ? 1 : 0;
    const appTokens = sig(app.name);
    const overlap = appTokens.filter((t) => textTokens.has(t)).length;
    const extra = appTokens.filter((t) => !textTokens.has(t)).length;
    const users = provisioned(app);
    const better =
      !best ||
      contain > best.contain ||
      (contain === best.contain && overlap > best.overlap) ||
      (contain === best.contain && overlap === best.overlap && extra < best.extra) ||
      (contain === best.contain && overlap === best.overlap && extra === best.extra && users > best.users);
    if (better) best = { app, contain, overlap, extra, users };
  }
  if (!best) return undefined;
  // No textual signal at all → the contract text is generic; attribute to the
  // vendor's most-adopted app rather than asserting a product the text never named.
  if (best.contain === 0 && best.overlap === 0) {
    const top = apps.slice().sort((a, b) => provisioned(b) - provisioned(a))[0];
    return { app: top, basis: "adoption" };
  }
  return { app: best.app, basis: "name" };
}

/** Earliest date in a list (ISO), as the representative renewal for display. */
function soonest(dates: string[]): string | undefined {
  const valid = dates.filter(Boolean).sort();
  return valid[0];
}

/** Parse an ISO date; undefined when absent or unparseable. */
function toDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * ACV of one contract = its total value ÷ its term in years — the way buyers and SaaS
 * Manager read a contract (for example, $300K over 18 months → $200K a year).
 *
 * Line-item amounts are the value for that line's own term (per the SaaS Manager API),
 * so a contract's line items add up to its total value (TCV). Multi-year
 * contracts often carry one line per year ("Year 1", "Year 2"), and a co-terming renewal
 * can start with a short stub year; annualizing each line separately would count every
 * year as a full annual run rate, so we divide the whole by the whole term instead.
 *
 * The term runs from the contract's start to its renewal date, rounded to the nearest half month so a 364-day year is 12 months. When
 * the dates are missing the total is treated as annual. One-time fees are left out.
 */
function contractAcv(lineItems: any[], contract: any): number {
  const recurring = lineItems.filter((li) => !isOneTimeLine(li?.description));
  const tcv = recurring.reduce((s, li) => s + (Number(li?.baseAmount ?? li?.amount) || 0), 0);
  const { start, end } = contractTerm(contract);
  if (!start || !end || end <= start) return tcv;
  const months = Math.max(0.5, Math.round(((end - start) / 86_400_000 / 30.4375) * 2) / 2);
  return (tcv * 12) / months;
}

/**
 * A contract's term: its own start → renewal (or end) date, as set in SaaS Manager. Line-item
 * dates are only a fallback when the contract has none — they're often copied from an older
 * contract (for example, a 2026–27 contract that still carries a 2024–25 line), and stretching the term to cover
 * them understated ACV.
 */
function contractTerm(contract: any): { start?: number; end?: number } {
  const t = (v: unknown) => toDate(v)?.getTime();
  const lines: any[] = contract?.lineItems ?? [];
  const lineStarts = lines.map((li) => t(li?.startDate)).filter((x): x is number => x != null);
  const lineEnds = lines.map((li) => t(li?.endDate)).filter((x): x is number => x != null);
  return {
    start: t(contract?.startDate) ?? (lineStarts.length ? Math.min(...lineStarts) : undefined),
    end: t(contract?.renewalDate) ?? t(contract?.endDate) ?? (lineEnds.length ? Math.max(...lineEnds) : undefined),
  };
}

/**
 * One-time fees (professional services, implementation, onboarding, training…) aren't part
 * of the annual run rate. The API has no billing-type flag, so this goes by the line-item
 * description — and only when it doesn't also name a subscription, licence or term, since
 * lines like "1 year term with implementation" bundle the subscription with setup.
 */
const ONE_TIME = /professional services|implementation|onboarding|consulting|training|one[- ]?time|one[- ]off|set[- ]?up fee/i;
const RECURRING_HINT = /subscription|licen[cs]e|platform|\bterm\b|\bseats?\b|\busers?\b|software|\bLMS\b|annual|year \d|renewal/i;
function isOneTimeLine(description: unknown): boolean {
  const d = typeof description === "string" ? description : "";
  return ONE_TIME.test(d) && !RECURRING_HINT.test(d);
}

/**
 * Which of an application's contracts make up its current ACV, as of `asOf`:
 *   • the ones in force or not yet started (renewal date on or after as-of, or no dates);
 *   • minus any that a not-yet-started contract renews — a renewal signed early starts
 *     within a month of the old contract's end, and counting both would double the ACV;
 *   • if every contract has ended, the most recent one, so the application still shows
 *     (as "renewal date has passed") with its last known ACV.
 * Expired contracts are history, not current spend.
 */
function currentContracts<T extends { start?: number; end?: number }>(cts: T[], asOf: number): T[] {
  const live = cts.filter((c) => c.end == null || c.end >= asOf);
  if (!live.length) {
    const latest = cts.reduce<T | undefined>((a, c) => (!a || (c.end ?? 0) > (a.end ?? 0) ? c : a), undefined);
    return latest ? [latest] : [];
  }
  const upcoming = live.filter((c) => c.start != null && c.start > asOf);
  const MONTH = 31 * 86_400_000;
  return live.filter((c) => !upcoming.some((u) => u !== c && c.end != null && Math.abs(u.start! - c.end) <= MONTH));
}

/** Bounded-concurrency map (keeps per-app user fetches from flooding the stdio server). */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * Derive adoption metrics from an app's raw user-account rows (GET /api/apps/v1/{appId}/users).
 * 1Password hands us RAW accounts, so we compute the metrics ourselves. `activeBasis`
 * is "status": status="Active" means the source integration currently reports the
 * account active, NOT that it was used recently (1Password, 2026-09). `lastLoginDtm`
 * is not reliably populated, so lastActivityDate is best-effort and often absent.
 */
function adoptionFromUsers(rows: any[]): AdoptionMetrics {
  const provisioned = rows.length;
  const active = rows.filter((u) => String(u?.status ?? "").toLowerCase() === "active").length;
  const logins = rows.map((u) => u?.lastLoginDtm).filter(Boolean).map(String).sort();
  return {
    provisionedUsers: provisioned,
    activeUsers: active,
    activeBasis: "status",
    pctActive: provisioned ? active / provisioned : undefined,
    lastActivityDate: logins.length ? logins[logins.length - 1] : undefined,
  };
}

/** Map one merged (contract + app) record into the normalized PortfolioApp shape. */
function normalizeOnePassword(app: Record<string, unknown>): PortfolioApp {
  const vendor = app.vendor as { name?: string } | undefined;
  const mainCategory = app.mainCategory as { name?: string } | undefined;
  return {
    name: String(pick(app, ["name"]) ?? "Unknown"),
    vendor: vendor?.name,
    descriptor: mainCategory?.name, // mainCategory drives match-query enrichment
    annualSpend: toNumber(pick(app, ["annualSpend", "annual_value", "annualValue"])),
    renewalDate: pick(app, ["renewalDate", "renewal_date"]) as string | undefined,
    reseller: undefined, // not expressible from this source
    raw: app,
  };
}

interface JoinStats {
  contracts: number;
  apps: number;
  vendors: number;
  /** Distinct matching units = applications with at least one attributed contract. */
  units: number;
  /** App records with no contract attributed to them (used-but-uncontracted). */
  noContract: number;
  /** How each contract's application was decided. */
  attribution: { byApi: number; byFile: number; byName: number; byAdoption: number; unattributed: number; trace: string[] };
}

/**
 * Pull + join the portfolio into application-level aggregates. Returns the
 * aggregates plus join stats (so callers can report coverage honestly).
 */
export async function pull1PasswordPortfolio(
  opts: { max?: number } = {},
): Promise<{ apps: PortfolioAppAgg[]; noContractApps: NoContractApp[]; stats: JoinStats }> {
  const client = new OnePasswordClient();
  await client.connect();
  const [contracts, appRecords] = await Promise.all([
    client.listAll("/api/contracts/v1"),
    client.listAll("/api/apps/v1"),
  ]);

  // Adoption: SaaS Manager has no app-level rollup, so we pull each app's raw user
  // accounts and compute the metrics. Guarded per app so a single failure doesn't
  // sink the pull; the whole step degrades to no-adoption — but we say so, with the
  // real HTTP status, because a 403 here means the API client lacks Apps.Users.Read.
  const adoptionByApp = new Map<string, AdoptionMetrics>();
  let adoptionError: string | undefined;
  try {
    await mapPool(appRecords, 5, async (a) => {
      if (!a?.id) return;
      try {
        const users = await client.listAll(`/api/apps/v1/${a.id}/users`);
        adoptionByApp.set(String(a.name).toLowerCase(), adoptionFromUsers(users));
      } catch (e) {
        adoptionError ??= safeErrorMessage(e);
      }
    });
  } catch (e) {
    adoptionError ??= safeErrorMessage(e);
  }
  if (adoptionByApp.size === 0 && adoptionError) {
    console.error(`  ! adoption unavailable: ${adoptionError}` + (/-> 403/.test(adoptionError) ? " (missing Apps.Users.Read scope?)" : ""));
  }
  client.close();

  // Index apps by id (the API join) and by normalized vendor name (the fallback join).
  const appById = new Map<string, VendorAppRef>();
  const appByExactName = new Map<string, VendorAppRef>();
  const appsByVendor = new Map<string, VendorAppRef[]>();
  for (const a of appRecords) {
    if (!a?.name) continue;
    const ref: VendorAppRef = { name: String(a.name), category: a.mainCategory?.name };
    if (a.id) appById.set(String(a.id), ref);
    appByExactName.set(ref.name, ref);
    const k = vendorKey(a.vendor?.name);
    if (k) (appsByVendor.get(k) ?? appsByVendor.set(k, []).get(k)!).push(ref);
  }
  const overrides = loadAttributionOverrides();

  // ── Aggregate by APPLICATION ─────────────────────────────────────────────────
  // One row per application: each contract is attributed to an app, then the app's ACV
  // is the sum over its CURRENT contracts (see currentContracts) — expired contracts are
  // history, and summing them overstated ACV several times over.
  const asOf = Date.parse(`${process.env.DEMO_AS_OF ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  interface CtAcv { acv: number; seats: number; start?: number; end?: number; renewalDate?: string }
  interface AAgg { appName: string; category?: string; vendorRaw: string; contracts: CtAcv[]; descriptions: Map<string, string> }
  const byApp = new Map<string, AAgg>();
  const attribution = { byApi: 0, byFile: 0, byName: 0, byAdoption: 0, unattributed: 0, trace: [] as string[] };
  const attributedAppNames = new Set<string>();

  for (const ct of contracts) {
    const vk = vendorKey(ct.vendorName);
    const li: any[] = ct.lineItems?.length ? ct.lineItems : [{}];
    // Roll the whole contract up first — attribution is per contract, not per line.
    // ACV (annual contract value) is derived from the contract's line items — the only
    // value figures the API exposes (there is no contract-level total; SaaS Manager has
    // no spend endpoint). Amounts prefer the tenant base-currency value (comparable across
    // currencies). contractAcv divides the contract's total by its term. The API carries
    // no billing-frequency or one-time flag, so this can still differ from the ACV shown in
    // the SaaS Manager UI; a contract-level value from the API would close that gap.
    const spend = contractAcv(li, ct);
    const term = contractTerm(ct);
    // Accounts on the contract: the lines in force at as-of (else its first term's), so a
    // per-year contract isn't counted once per year.
    const recurring = li.filter((i: any) => !isOneTimeLine(i?.description));
    const lineStart = (i: any) => toDate(i?.startDate)?.getTime();
    const lineEnd = (i: any) => toDate(i?.endDate)?.getTime();
    const inForce = recurring.filter((i: any) => (lineStart(i) ?? -Infinity) <= asOf && (lineEnd(i) ?? Infinity) >= asOf);
    const firstStart = Math.min(...recurring.map((i: any) => lineStart(i) ?? Infinity));
    const seatLines = inForce.length ? inForce : recurring.filter((i: any) => (lineStart(i) ?? Infinity) === firstStart || lineStart(i) == null);
    const seats = seatLines.reduce((n: number, i: any) => n + (Number(i?.unitCount) || 0), 0);
    const fileEntry = overrides.get(ct.id);
    const text = [ct.ref, ...li.map((i: any) => i.description)].filter((s) => s && s !== "undefined").join(" ");
    const label = ct.ref && ct.ref !== "undefined" ? ct.ref : text || "(no ref)";

    // Attribution, strongest signal first:
    //   1. API `app` — the Main application the buyer set in SaaS Manager (authoritative)
    //   2. attribution file — the same field, hand-copied from the UI until the API ships it
    //   3. heuristic — name/adoption reconstruction from the vendor's app records
    let picked: { app: VendorAppRef; basis: "api" | "file" | "name" | "adoption" } | undefined;
    if (ct.app?.id || ct.app?.name) {
      const rec = ct.app.id ? appById.get(String(ct.app.id)) : undefined;
      // Display the app RECORD's name (what the UI shows); `app.name` is the global
      // catalog name and may differ from the customer's instance name.
      picked = { app: rec ?? { name: String(ct.app.name) }, basis: "api" };
    } else if (overrides.has(ct.id)) {
      const want = fileEntry?.app ?? null;
      if (fileEntry === null || want == null) {
        attribution.unattributed++;
        attribution.trace.push(`NO-APP     "${label}" · vendor="${ct.vendorName}" · $${Math.round(spend)} — no Main application set`);
        continue;
      }
      const hit = appByExactName.get(want);
      if (hit) picked = { app: hit, basis: "file" };
      else console.error(`  ! attribution file names "${want}", which is not an app record — falling back to heuristic`);
    }
    if (!picked && vk) picked = attributeContractToApp(text, ct.vendorName, appsByVendor.get(vk) ?? [], adoptionByApp);
    if (!picked) {
      attribution.unattributed++;
      attribution.trace.push(`UNJOINED   "${label}" · vendor="${ct.vendorName}" · $${Math.round(spend)} — no application to attribute to`);
      continue;
    }
    if (picked.basis === "api") attribution.byApi++;
    else if (picked.basis === "file") attribution.byFile++;
    else if (picked.basis === "name") attribution.byName++;
    else attribution.byAdoption++;
    const tag = { api: "API        ", file: "FILE       ", name: "by-name    ", adoption: "by-adopt   " }[picked.basis];
    attribution.trace.push(`${tag}"${label}" · vendor="${ct.vendorName}" → ${picked.app.name} · ACV $${Math.round(spend).toLocaleString()}`);
    attributedAppNames.add(picked.app.name.toLowerCase());

    const key = picked.app.name.toLowerCase();
    const e: AAgg = byApp.get(key) ?? { appName: picked.app.name, category: picked.app.category, vendorRaw: ct.vendorName, contracts: [], descriptions: new Map() };
    e.contracts.push({ acv: spend, seats, ...term, renewalDate: ct.renewalDate });
    // Keep product-bearing line-item descriptions (deduped) — the matcher uses them
    // to narrow a pending app's candidates to the SKU the contract actually names.
    for (const item of li) {
      const d = typeof item.description === "string" ? item.description.trim() : "";
      if (d && d !== "undefined" && isProductDescription(d, ct.vendorName)) e.descriptions.set(d.toLowerCase(), d);
    }
    byApp.set(key, e);
  }

  // No-contract apps: an app record that no contract is attributed to. With no spend
  // endpoint, a missing contract means no spend signal at all → data-gap / shadow IT.
  const noContractApps: NoContractApp[] = [];
  for (const a of appRecords) {
    if (!a?.name || attributedAppNames.has(String(a.name).toLowerCase())) continue;
    noContractApps.push({
      name: String(a.name),
      vendor: a.vendor?.name,
      descriptor: a.mainCategory?.name,
      adoption: adoptionByApp.get(String(a.name).toLowerCase()),
      status: a.status ? String(a.status) : undefined,
    });
  }

  const out: PortfolioAppAgg[] = [];
  const vendorsSeen = new Set<string>();
  for (const [, e] of byApp) {
    vendorsSeen.add(vendorKey(e.vendorRaw));
    const current = currentContracts(e.contracts, asOf);
    const renewals = current.map((c) => c.renewalDate).filter((d): d is string => !!d);
    const app = normalizeOnePassword({
      name: e.appName,
      vendor: { name: e.vendorRaw },
      mainCategory: e.category ? { name: e.category } : undefined,
      annualSpend: current.reduce((s, c) => s + c.acv, 0),
      renewalDate: soonest(renewals),
    });
    out.push({
      ...app, contractCount: current.length, renewals, seats: current.reduce((n, c) => n + c.seats, 0),
      lineItemDescriptions: e.descriptions.size ? [...e.descriptions.values()] : undefined,
      adoption: adoptionByApp.get(e.appName.toLowerCase()),
    });
  }
  out.sort((a, b) => (b.annualSpend ?? 0) - (a.annualSpend ?? 0));
  const limited = opts.max ? out.slice(0, opts.max) : out;

  return {
    apps: limited,
    noContractApps,
    stats: { contracts: contracts.length, apps: appRecords.length, vendors: vendorsSeen.size, units: byApp.size, noContract: noContractApps.length, attribution },
  };
}

/**
 * App shape VERIFIED against the live API (2026-09-23). `mainCategory` is the
 * descriptor for match-query enrichment. Spend + renewal come from joined CONTRACTS;
 * contracts have no reseller/source field, so reseller is not expressible from this source.
 */
export const onePasswordAdapter: SaaSProvider = {
  id: "1password",
  label: "1Password SaaS Manager",
  contributes: "SaaS portfolio: applications + vendor + category; spend/renewal via contracts attributed to their main application.",
  defaultEndpoint: `https://${DEFAULT_HOST}`,
  endpointEnvVar: "ONEPASSWORD_SM_HOST",
  // NOTE: auth is OAuth client-credentials (client id + secret → short-lived bearer),
  // not a static token. The credentials live in the OS credential store via `npm run login`;
  // the env var below is only the documented non-macOS escape hatch.
  tokenEnvVar: "ONEPASSWORD_SM_CLIENT_SECRET",
  authScheme: "bearer",
  descriptorSource: "mainCategory",
  setup: [
    "**Connect 1Password SaaS Manager:** this reads your portfolio through the SaaS Manager API using an API client you create in SaaS Manager (credentials in the macOS keychain, or on Windows a file encrypted to your Windows account — no secret in `.env`).",
    "1. In SaaS Manager go to **Settings › API Access › New**. OAuth 2.0 configuration: **Client credentials**. Scopes: **Read apps** (Apps.Read), **Read app accounts** (Apps.Users.Read), **Read contracts** (Contracts.Read).",
    "2. Store the credentials (the secret is read from stdin, so it stays off your shell history; use `--host trelica.eu` for EU tenants):",
    "   `npm run login -- --host trelica.app --client-id <YOUR_CLIENT_ID>`",
    "3. Verify: `npm run status` should print `API: ok (GET /api/apps/v1 -> 200)`, then re-check the connection.",
  ].join("\n"),
  capabilities: {
    descriptor: true, // mainCategory
    vendor: true, // vendor.name
    spend: true, // via contracts only (no spend endpoint): current contracts' lineItems[].baseAmount ÷ term (contractAcv), attributed to the app
    renewalDate: true, // via contracts (renewalDate)
    reseller: false, // VERIFIED: no reseller/source field or custom field on contracts
    adoption: true, // per-app user accounts via GET /api/apps/v1/{appId}/users (status-based active)
  },
  normalize: normalizeOnePassword,
  /**
   * Connectivity check for onboarding: mint a token with the stored credentials and
   * make the smallest authenticated call — the same thing `npm run status` prints.
   */
  async probeConnection(): Promise<{ connected: boolean; detail?: string }> {
    let found;
    try {
      found = loadCredentials();
    } catch (e) {
      return { connected: false, detail: safeErrorMessage(e) };
    }
    if (!found) {
      return { connected: false, detail: missingCredentialsMessage() };
    }
    const client = new OnePasswordClient();
    try {
      await client.connect();
      await client.get("/api/apps/v1", { limit: 1 });
      return { connected: true };
    } catch (e) {
      return { connected: false, detail: `SaaS Manager API check failed: ${safeErrorMessage(e)}` };
    }
  },
  async pull(opts: { max?: number } = {}): Promise<PortfolioPull> {
    const max = opts.max;
    const { apps, noContractApps, stats } = await pull1PasswordPortfolio({ max: max === Infinity ? undefined : max });
    const at = stats.attribution;
    return {
      apps,
      noContractApps,
      contractCount: stats.contracts,
      note:
        `${stats.contracts} contracts → ${apps.length} application units across ${stats.vendors} vendors ` +
        `(attribution: ${at.byApi} from API, ${at.byFile} from file, ${at.byName} by name, ${at.byAdoption} by adoption, ${at.unattributed} unattributed) · ` +
        `${stats.noContract} used-but-uncontracted app(s).` +
        (at.trace.length ? `\n  ${at.trace.join("\n  ")}` : ""),
    };
  },
};

// ── Smoke test entrypoint ─────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const limit = Number(process.argv[2] ?? 12);
  pull1PasswordPortfolio()
    .then(({ apps, stats }) => {
      const money = (n: number) => "$" + Math.round(n).toLocaleString();
      console.log(`\n=== 1Password ingest (by application) ===`);
      console.log(`  ${stats.contracts} contracts · ${stats.apps} apps · ${stats.vendors} vendors`);
      console.log(`  application units: ${stats.units} · attribution: ${stats.attribution.byApi} API / ${stats.attribution.byFile} file / ${stats.attribution.byName + stats.attribution.byAdoption} heuristic / ${stats.attribution.unattributed} unattributed`);
      console.log(`\n  Top ${limit} by spend:`);
      for (const a of apps.slice(0, limit)) {
        console.log(
          `    ${a.name.padEnd(34)} vendor=${(a.vendor ?? "?").padEnd(22)} ${money(a.annualSpend ?? 0).padStart(12)}` +
            `  contracts=${a.contractCount} seats=${a.seats}`,
        );
      }
    })
    .catch((err) => {
      console.error("1Password ingest smoke test failed:", safeErrorMessage(err));
      process.exitCode = 1;
    });
}
