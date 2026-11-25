/**
 * Buyer-facing report — vendor-first, buyer-confirmed.
 *
 * Reads analytics-results.json (per-app records + bucket totals) and any
 * selections.json, and emits TWO artifacts:
 *   • report.json           — the structured CONTRACT a UI or the agent builds on.
 *   • CONSOLIDATION-REPORT.md — a Markdown a buyer's AI tool can present + act on:
 *       three sections (Confirmed / Confirm-your-product / Not-on-Marketplace),
 *       each pending app listing its vendor's candidate products + "none of these"
 *       with stable listing IDs the tool records back into selections.json.
 *
 * No SKU is asserted that isn't either buyer-confirmed or a single tight/sole match.
 *
 * Run:  node --env-file=.env --import tsx src/report.ts [--top N]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyticsResultsPath, reportJsonPath, reportMdPath, reportHtmlPath, selectionsPath, actionsPath, agreementsPath, alreadyOnMarketplacePath, deploymentPath, comparisonsPath, matchResultsPath, shadowItSuggestionsPath, mcpHealthPath } from "./paths.js";
import { readMcpHealth, healthTotals } from "./mcpShapes.js";
import { renderProblems } from "./renderCheck.js";
import { readCatalogChoice, CATALOG_LABEL } from "./catalog.js";
import { configuredProfile } from "./discoveryAuth.js";
import { LeadContext, leadRecipient, renewSubject, renewBodyTemplate, buildMailto, purchaseSubject, purchaseBodyTemplate } from "./lead.js";
// §2 interactive selection: needs the provider id (not the human label) for the
// dynamic `out/<provider>/selections.json` path in the inline instructions.
import { activeSaaSProvider } from "./saasAdapters.js";
// Attribution for every Marketplace URL this report emits — strips the
// MAX_MCP tracking tags, sets the bundle's `ref_` + `src`. Also self-migrates
// URLs pulled in from caches/outputs written before this helper existed.
import { rewriteMarketplaceUrl } from "./marketplaceUrl.js";
import { cleanString, forAgent } from "./untrusted.js";

interface Candidate { listingId: string; title: string; categories?: string[] }
interface AppRecord {
  app: string;
  vendor?: string;
  sellerName?: string;
  status: "confirmed" | "needs_selection" | "not_on_marketplace";
  granularity?: boolean;
  spend: number;
  seats?: number | null;
  candidateCount?: number;
  candidates?: Candidate[];
  resolved?: { listingId: string; title?: string } | null;
  next_renewal?: string | null;
  renewal_bucket?: string;
  renewal_urgency?: string;
  rationale?: string;
  /** What settled or narrowed the match: the app name, or a contract line item. */
  matchedBy?: "app_name" | "line_item";
  lineItemDescriptions?: string[];
}
interface Analytics {
  as_of: string;
  generated_from: string;
  counts: { confirmed: number; needs_selection: number; not_on_marketplace: number };
  confirmed_usd: number;
  pending_usd: number;
  not_on_marketplace_usd: number;
  renewing_90d_confirmed_usd: number;
  apps: AppRecord[];
  disclaimer: string;
}
type Selections = Record<string, { listingId?: string; none?: boolean }>;
interface ActionLinks { listingId: string; procurementUrl?: string; privateOfferUrl?: string; demoUrl?: string; freeTrialUrl?: string; listingUrl?: string }
type Actions = Record<string, ActionLinks>;
interface Agreement { app: string; vendor?: string; agreementId: string; status: string; startTime?: string; endTime?: string; committedUsd?: number; assumed?: boolean }
interface AgreementsFile { connected?: boolean; reason?: string; assumed?: boolean; note?: string; realAgreementCount?: number; committedUsd?: number; byApp: Record<string, Agreement> }
type DeployedOnAws = "yes" | "no" | "unknown";
interface DeploymentStatus { listingId: string; deployedOnAws: DeployedOnAws; fulfillmentTypes?: string[]; badges?: string[] }
type Deployment = Record<string, DeploymentStatus>;
// Comparable solutions (from enrichComparisons via the Marketplace MCP).
type Polarity = "POSITIVE" | "MIXED" | "NEGATIVE";
interface CmpProduct {
  listingId: string; name: string; vendor?: string; isSeed: boolean; url?: string;
  bestRank?: { category: string; rank: number } | null;
  rating?: number | null; reviewCount?: number | null;
  sentiments: Partial<Record<"functionality" | "ease_of_use" | "customer_service" | "cost_effectiveness", Polarity>>;
  highlights: string[]; hasStandardContract?: boolean | null;
}
interface Comparison { app: string; seedListingId: string; candidateSource: "related" | "category-search" | "none"; products: CmpProduct[] }
type Comparisons = Record<string, Comparison>;
// Adoption + used-but-uncontracted apps (from ingestMatch → match-results.json).
interface AdoptionRec { provisionedUsers?: number; activeUsers?: number; activeBasis?: "activity" | "status"; pctActive?: number; lastActivityDate?: string }
interface NoContractAppRec { name: string; vendor?: string; descriptor?: string; adoption?: AdoptionRec
  status?: string;
}
// unmanaged-use product suggestions (from enrichShadowIt via the Marketplace MCP).
interface ShadowItSug { app: string; found: boolean; suggested?: { listingId: string; title: string; vendor?: string }; procurementUrl?: string; privateOfferUrl?: string; listingUrl?: string; note: string }

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const big = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
// Every name written into the report (application, vendor and product names, line items) goes
// through cleanString first: it strips characters that hide text from a reader but not from a model
// (zero-width, bidi overrides, Unicode tag characters), so text the dashboard hands back to the agent
// ("Copy for your agent") can't carry a hidden payload.
const cell = (s: string | undefined) => cleanString(s ?? "—").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const esc = (s: string | undefined) =>
  cleanString(s ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const URGENCY: Record<string, string> = { act_now: "≤90 days", plan: "within 1 year", monitor: "later", expired: "past", unknown: "no date" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const SENT: Record<Polarity, string> = { POSITIVE: "✅", MIXED: "⚠️", NEGATIVE: "❌" };
const sent = (p?: Polarity) => (p ? SENT[p] : "–");
const rankLabel = (r?: { category: string; rank: number } | null) => (r ? `Top ${r.rank} · ${r.category}` : "–");
const ratingLabel = (p: CmpProduct) => (p.rating ? `⭐ ${p.rating}${p.reviewCount ? ` (${p.reviewCount.toLocaleString()})` : ""}` : "–");

/**
 * The consolidation buckets. `label` is the full name (stat strip, section heading), `tab` the
 * short name, `what` the one-line meaning shown under each stat. Ready / Needs confirmation / Not on
 * Marketplace split the contracted portfolio and add up to its ACV; Missing a contract has no ACV;
 * Counts toward your AWS commitment is part of Ready.
 */
const BUCKETS = {
  already: { label: "Already on AWS Marketplace", tab: "Already bought", what: "bought through Marketplace; no action needed" },
  ready: { label: "Ready to renew on Marketplace", tab: "Ready to renew", what: "matched to an AWS Marketplace product" },
  confirm: { label: "Needs your confirmation", tab: "Needs confirmation", what: "vendor sells on Marketplace; confirm which product" },
  notmp: { label: "Not on AWS Marketplace", tab: "Not on Marketplace", what: "vendor doesn't sell on AWS Marketplace" },
  nocontract: { label: "Missing a contract", tab: "Missing contract", what: "in use, but no contract in SaaS Manager" },
  ppa: { label: "Counts toward your AWS commitment", tab: "", what: "" },
} as const;
/** A stat in the strip; with `tab`, it's a link that opens that report tab. */
const card = (label: string, count: number, usd: number, kind: string, tab: string | undefined, what: string, stat?: string) => {
  const tag = tab ? `a href="#${tab}" data-tab="${tab}"` : "div";
  const at = (k: string) => (stat ? ` data-stat="${stat}-${k}"` : "");
  return `<${tag} class="card ${kind}"><div class="k">${label}</div><div class="v"${at("usd")}>${big(usd)}</div><div class="c"><span${at("n")}>${count.toLocaleString()}</span> applications · ${what}</div></${tab ? "a" : "div"}>`;
};
/** AWS Marketplace logo (src/assets/aws-marketplace-logo.png), embedded as a data URI; omitted if missing. */
const AWS_MARKETPLACE_LOGO = (() => {
  const f = fileURLToPath(new URL("./assets/aws-marketplace-logo.png", import.meta.url));
  return existsSync(f) ? `data:image/png;base64,${readFileSync(f).toString("base64")}` : "";
})();
/** Brand names fixed by the bundle (config/bundle.json), with defaults. */
const BRAND = (() => {
  const f = process.env.BUNDLE_CONFIG_FILE ?? "config/bundle.json";
  let c: { productName?: string; reportName?: string } = {};
  try { if (existsSync(f)) c = JSON.parse(readFileSync(f, "utf8")); } catch { /* defaults below */ }
  return { product: c.productName || "1Password SaaS Manager", report: c.reportName || "AWS Marketplace Consolidation Insights" };
})();

interface ActLinks { procurementUrl?: string; privateOfferUrl?: string; demoUrl?: string; freeTrialUrl?: string; listingUrl?: string }
const attrEsc = (s: string) => cleanString(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/**
 * A link that came from outside data (the Marketplace MCP, Discovery, a cached file): https only.
 * Anything else — javascript:, data:, a relative path — becomes "" so the caller drops the link,
 * so a bad or tampered catalog value can never run script in the dashboard.
 */
const safeHttps = (url: string | null | undefined): string => {
  if (!url) return "";
  try { return new URL(url).protocol === "https:" ? url : ""; } catch { return ""; }
};
/**
 * Buyer action buttons for a CONFIRMED (already-owned, matched) app.
 * "Buy on Marketplace" and "Request a private offer" are not shown — these apps are
 * already owned (that's why they're in SaaS Manager). The primary
 * CTA is now "Renew on Marketplace", a prefilled mailto that captures a lead for
 * the AWS customer-advisor team (contact fields left blank for the buyer to fill,
 * since a static file can't prompt — the CLI form `npm run renew-lead` is the
 * structured path). The "Demo" link was also dropped (2026-09-04): these apps are
 * already owned, so a product demo is not a relevant CTA — the same owned-product reason.
 */
/**
 * A lead email button. The href stays a plain mailto: (works with no JS, and in a
 * default mail app); the page script intercepts clicks on `.lead-mail` to open the
 * same pre-filled draft in the buyer's chosen client — Gmail, Outlook (work/school),
 * Outlook.com or the default mail app — asked once and remembered (see SCRIPT).
 */
/**
 * "Already on Marketplace" toggle for one application (a tertiary text button). Like the
 * product dropdowns, a click only marks the row on this page; the change is applied when the
 * buyer hands it to the agent (Copy for your agent), which records it and regenerates.
 * `marked` = already recorded (shown in the Already section, where the action is to undo).
 */
function markToggle(app: string, marked: boolean): string {
  return marked
    ? `<button type="button" class="mark-mp" data-mark-app="${attrEsc(app)}" data-marked="1" aria-pressed="false">Not on Marketplace? Undo</button>`
    : `<button type="button" class="mark-mp" data-mark-app="${attrEsc(app)}" aria-pressed="false" title="You already buy this through AWS Marketplace: move it out of the opportunities">Already on Marketplace</button>`;
}

/** One item of the email-app menu: a label plus a secondary line saying who it's for. */
function mcOpt(client: string, label: string, sub: string): string {
  return `<button type="button" class="mc-opt mc-two" role="menuitem" data-client="${client}"><span>${esc(label)}</span><span class="mc-sub">${esc(sub)}</span></button>`;
}

function leadMailHtml(mailto: string, label: string, cls: string): string {
  return `<a class="btn ${cls} lead-mail" href="${attrEsc(mailto)}" title="Opens a pre-filled email to the AWS Marketplace team in your email app">${label}</a>`;
}
function renewHtml(mailto: string, compareAnchor?: string): string {
  const b: string[] = [leadMailHtml(mailto, "Renew on Marketplace ↗", "primary")];
  // Review comparable Marketplace solutions: opens the comparison row under this one (SCRIPT).
  if (compareAnchor) b.push(`<button type="button" class="btn secondary" data-cmp-toggle="${compareAnchor}" aria-controls="${compareAnchor}" aria-expanded="false" title="Review comparable AWS Marketplace solutions">Compare</button>`);
  return b.join(" ");
}
/** Callout severities, each with its icon (src/theme/icons.json). */
type CalloutSeverity = "informational" | "success" | "warning" | "critical";
const THEME_ICONS = JSON.parse(readFileSync(fileURLToPath(new URL("./theme/icons.json", import.meta.url)), "utf8"));
function themeIcon(severity: CalloutSeverity): string {
  const icon = THEME_ICONS.icons[severity];
  const paths = icon.paths.map((p: { d: string; fillRule?: string; clipRule?: string }) =>
    `<path d="${p.d}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}${p.clipRule ? ` clip-rule="${p.clipRule}"` : ""}/>`).join("");
  return `<svg class="callout-icon" viewBox="${THEME_ICONS.viewBox}" aria-hidden="true" focusable="false">${paths}</svg>`;
}
/** The checkbox check mark (white) as a CSS url() for the checked state. */
function themeCheckmarkUrl(): string {
  const icon = THEME_ICONS.icons.checkbox;
  const paths = icon.paths.map((p: { d: string; fillRule?: string; clipRule?: string }) =>
    `<path fill="white" d="${p.d}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}${p.clipRule ? ` clip-rule="${p.clipRule}"` : ""}/>`).join("");
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${THEME_ICONS.viewBox}">${paths}</svg>`)}")`;
}
/** A theme icon as a CSS mask url(): draw it with background-color so it follows the theme. */
function themeIconMask(name: string): string {
  const icon = THEME_ICONS.icons[name];
  const paths = icon.paths.map((p: { d: string; fillRule?: string; clipRule?: string }) =>
    `<path d="${p.d}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}${p.clipRule ? ` clip-rule="${p.clipRule}"` : ""}/>`).join("");
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${THEME_ICONS.viewBox}">${paths}</svg>`)}")`;
}
/** The 1Password logo, drawn in the text colour. */
function brandLogo(): string {
  const icon = THEME_ICONS.icons.logo;
  const paths = icon.paths.map((p: { d: string; fillRule?: string; clipRule?: string }) =>
    `<path d="${p.d}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}${p.clipRule ? ` clip-rule="${p.clipRule}"` : ""}/>`).join("");
  return `<svg class="brand-logo" viewBox="${THEME_ICONS.viewBox}" aria-hidden="true" focusable="false">${paths}</svg>`;
}
/** A Callout (card variant). `html` is trusted, already-escaped markup. */
function calloutHtml(severity: CalloutSeverity, html: string): string {
  const role = severity === "warning" || severity === "critical" ? "alert" : "note";
  return `<div class="callout ${severity}" role="${role}">${themeIcon(severity)}<div class="callout-content">${html}</div></div>`;
}
/** Compact PPA-eligibility badge for the Confirmed table. */
function ppaHtml(s: DeployedOnAws): string {
  if (s === "yes") return `<span class="pill success" title="Deployed on AWS — counts toward PPA/EDP drawdown">✓ AWS</span>`;
  if (s === "no") return `<span class="pill critical" title="Not deployed on AWS — does NOT count toward PPA drawdown">✗ non-AWS</span>`;
  return `<span class="pill" title="Deployment status unknown">?</span>`;
}
function ppaMd(s: DeployedOnAws): string {
  if (s === "yes") return "✓ AWS";
  if (s === "no") return "✗ non-AWS";
  return "?";
}

/** Buyer action links (Markdown). Renewal CTA; buy/private-offer not shown for owned apps. */
function renewMd(mailto: string, compareAnchor?: string): string {
  const b: string[] = [`[Renew on Marketplace](${mailto})`];
  if (compareAnchor) b.push(`[Review comparable solutions](#${compareAnchor})`);
  return b.join(" · ");
}

const CSS = `
/* Report palette = the theme tokens. The --theme-* values come from THEME_TOKENS
   (src/theme/tokens.css), which also handles
   dark mode; these short names just point at them. */
:root {
  --fg: var(--theme-text-icon-neutral);
  --muted: var(--theme-text-icon-neutral-weak);
  --line: var(--theme-border-neutral);
  --bg: var(--theme-background-neutral);
  --panel: var(--theme-background-neutral-high);
  --ok: var(--theme-text-icon-success);
  --okbg: var(--theme-background-success-weak);
  --warn: var(--theme-text-icon-warning);
  --warnbg: var(--theme-background-warning-weak);
  --crit: var(--theme-text-icon-critical);
  --critbg: var(--theme-background-critical-weak);
  --brand: var(--theme-text-icon-brand);
  --brandbg: var(--theme-background-brand-weak);
  --brandline: var(--theme-border-brand);
  --brandfill: var(--theme-background-brand);
  --attn: var(--theme-text-icon-attention);
  --attnbg: var(--theme-background-attention-weak);
  --attnfill: var(--theme-background-attention);
  --onfill: var(--theme-text-icon-inverse);
  --mutedc: var(--theme-text-icon-neutral);
  --mutedbg: var(--theme-background-neutral-low);
  --code: var(--theme-background-brand-weak);
  --elev: var(--theme-elevation-low);
  --r-s: var(--theme-corner-radius-small); --r-m: var(--theme-corner-radius-medium); --r-l: var(--theme-corner-radius-large);
  /* The theme names its fonts without fallbacks; keep system fallbacks for readers without them. */
  --font: var(--theme-font-family-default), Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: var(--theme-font-family-code), ui-monospace, SFMono-Regular, Menlo, monospace; }
* { box-sizing: border-box; }
/* The page script shows/hides elements with the hidden attribute; keep it winning over component display rules. */
[hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--fg); font:var(--theme-font-size-body-medium)/var(--theme-line-height-paragraph) var(--font);
  letter-spacing:var(--theme-letter-spacing-body-medium); }
main { max-width: 1120px; margin: 0 auto; padding: 40px 24px 80px; }
/* Headings = Heading scale (large 28 / medium 20 / small 16), semibold. */
h1, h2, h3 { font-weight:var(--theme-font-weight-heading-default); line-height:var(--theme-line-height-heading-large);
  font-feature-settings:var(--theme-heading-font-feature-settings); }
h1 { font-size:var(--theme-heading-font-size-large); letter-spacing:var(--theme-heading-letter-spacing-large); margin:0 0 var(--theme-spacing-2xs); }
h2 { font-size:var(--theme-heading-font-size-medium); letter-spacing:var(--theme-heading-letter-spacing-medium);
  margin:var(--theme-spacing-2xl) 0 var(--theme-spacing-xs); padding-top:var(--theme-spacing-medium); border-top:1px solid var(--theme-divider-color-neutral-weak); }
h3 { font-size:var(--theme-heading-font-size-small); letter-spacing:var(--theme-heading-letter-spacing-small); margin:0 0 2px; }
.sub { color:var(--muted); margin:0 0 var(--theme-spacing-large); }
/* Brand line, as in SaaS Manager's sidebar header: logo + product name. */
.brand { display:flex; align-items:center; gap:var(--theme-spacing-xs); margin:0 0 var(--theme-spacing-xs);
  font-size:var(--theme-heading-font-size-xs); font-weight:var(--theme-font-weight-heading-default); letter-spacing:var(--theme-heading-letter-spacing-xs); }
.brand-logo { width:20px; height:20px; fill:var(--theme-text-icon-neutral); flex:none; }
.report-head .sub { margin-bottom:0; }
.data-notice { margin:var(--theme-spacing-large) 0 0; padding:var(--theme-spacing-medium) var(--theme-spacing-large); border:1px solid var(--warn); background:var(--warnbg); border-radius:8px; color:var(--fg); }
.data-notice p { margin:0; }
.data-notice p + p { margin-top:8px; }
.data-notice strong { color:var(--warn); }
.data-notice ul { margin:6px 0 0; padding-left:20px; }
.catalog-note { color:var(--muted); font-size:.9em; margin:4px 0 0; }
/* AWS Marketplace logo in the top-right corner of the brand line. It keeps its own dark background
   (it's the white-text version), so it reads in light and dark mode. */
.partner-logo { flex:none; margin-left:auto; height:28px; width:auto; border-radius:var(--theme-corner-radius-small); }
.portfolio-line { margin:var(--theme-spacing-large) 0 var(--theme-spacing-xs); color:var(--fg); }
/* Headline numbers = SaaS Manager's stat strip: one card, stats split by hairline dividers
   (a 1px grid gap over the divider colour, so it still reads right when it wraps). */
/* Column count is set per report (--cols) so the tiles always fill whole rows: up to 5 in one row,
   6 as 3 × 2. An auto-fit grid left an empty grey cell when the 6th tile wrapped on its own. */
.cards { display:grid; grid-template-columns:repeat(var(--cols, 4), minmax(0, 1fr)); gap:var(--theme-divider-border-width-one);
  margin:var(--theme-spacing-large) 0 var(--theme-spacing-small); background:var(--theme-divider-color-neutral);
  border-radius:var(--theme-card-corner-radius); box-shadow:var(--theme-card-elevation); overflow:hidden; }
.card { background:var(--panel); padding:var(--theme-spacing-medium) var(--theme-spacing-large); min-width:0;
  display:flex; flex-direction:column; }
/* Labels reserve two lines, so numbers and captions line up across the strip even when a tile has more below. */
.card .k { min-height:calc(2 * var(--theme-line-height-paragraph) * 1em); }
/* Lead tile (Ready to renew): informational surface. */
.card.ready { background:var(--theme-callout-background-color-informational); box-shadow:inset 0 0 0 1px var(--theme-callout-border-color-informational); }
a.card.ready:hover { background:var(--theme-callout-background-color-informational); }
.ready-soon { margin-top:var(--theme-spacing-2xs); color:var(--theme-text-icon-warning); font-size:var(--theme-font-size-body-small);
  font-weight:var(--theme-font-weight-body-strong); letter-spacing:var(--theme-letter-spacing-body-small); }

/* Stats that open a tab. */
@media (max-width: 760px) { .cards { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .cards > .card:last-child:nth-child(odd) { grid-column:span 2; } }
@media (max-width: 440px) { .cards { grid-template-columns:1fr; } .cards > .card:last-child:nth-child(odd) { grid-column:auto; } }
a.card { color:inherit; text-decoration:none; cursor:pointer; }
a.card:hover { background:var(--theme-background-neutral); }
a.card:focus-visible { outline:var(--theme-focus-outline); outline-offset:calc(-1 * var(--theme-focus-outline-width)); }
/* Tabs = Tabs: 14px labels (brand when selected), 16px apart over a hairline; the selected tab
   carries a 2px focus-blue underline, hover a 1px one. Counts sit in pills. */
.tabs-bar { display:flex; align-items:flex-end; justify-content:space-between; gap:var(--theme-spacing-medium);
  margin:var(--theme-spacing-large) 0 0; border-bottom:var(--theme-tabs-tabs-list-border-height) solid var(--theme-border-neutral); }
.tabs { display:flex; flex-wrap:wrap; gap:0 var(--theme-tabs-tabs-list-gap); padding-bottom:var(--theme-tabs-tabs-list-padding-vertical-end); }
.tab { position:relative; display:inline-flex; align-items:center; gap:var(--theme-spacing-xs); min-height:var(--theme-tabs-min-height);
  padding:var(--theme-spacing-xs) var(--theme-spacing-2xs); border-radius:var(--theme-corner-radius-small);
  color:var(--theme-text-icon-neutral); font-size:var(--theme-font-size-body-medium); text-decoration:none; white-space:nowrap; cursor:pointer; }
.tab::after { content:""; position:absolute; left:0; right:0; height:calc(2 * var(--theme-tabs-tab-border-height));
  bottom:calc(-1 * (var(--theme-tabs-tabs-list-padding-vertical-end) + var(--theme-tabs-tabs-list-border-height)));
  border-radius:var(--theme-corner-radius-medium); background:transparent; }
.tab:hover::after { height:var(--theme-tabs-tab-border-height); background:var(--theme-border-neutral); }
.tab:active::after { background:var(--theme-border-neutral-strong); }
.tab[aria-selected="true"] { color:var(--theme-text-icon-brand); }
.tab[aria-selected="true"]::after, .tab[aria-selected="true"]:hover::after { height:calc(2 * var(--theme-tabs-tab-border-height)); background:var(--theme-border-focus); }
.tab:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-tabs-tab-outline-offset); }
.tabs-bar .btn { margin:0 0 var(--theme-spacing-2xs); }
.tab-panel { outline:none; }
.tab-panel:focus-visible { outline:var(--theme-focus-outline); outline-offset:calc(-1 * var(--theme-focus-outline-width)); }
.tab-panel > h2:first-child { margin-top:var(--theme-spacing-large); padding-top:0; border-top:0; }
/* Actions = a card listing what needs attention (SaaS Manager's Actions panel); each row opens its tab. */
.actions { background:var(--panel); border-radius:var(--theme-card-corner-radius); box-shadow:var(--theme-card-elevation);
  padding:var(--theme-spacing-medium) var(--theme-spacing-large) var(--theme-spacing-2xs); margin:var(--theme-spacing-large) 0 var(--theme-spacing-medium); }
.actions h3 { margin:0; }
.action-intro { color:var(--muted); margin:var(--theme-spacing-2xs) 0 var(--theme-spacing-xs); }
.action-row { display:flex; align-items:center; justify-content:space-between; gap:var(--theme-spacing-medium);
  padding:var(--theme-spacing-small) 0; border-top:1px solid var(--theme-border-neutral-weak); color:inherit; text-decoration:none; }
.action-row:hover .action-title { text-decoration:underline; text-underline-offset:3px; }
.action-row:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); border-radius:var(--theme-corner-radius-small); }
.action-title { display:block; font-weight:var(--theme-font-weight-body-strong); }
.action-sub { display:block; color:var(--muted); }
.action-n { font-size:var(--theme-heading-font-size-medium); font-weight:var(--theme-font-weight-heading-default); color:var(--theme-text-icon-warning);
  font-feature-settings:var(--theme-heading-font-feature-settings-numeric); }
/* Printing (and "Show all sections") shows every tab panel. */
@media print { :root { color-scheme:light; } .tabs-bar, .mail-chooser, .mail-toast, .sel-bar { display:none !important; } .tab-panel[hidden] { display:block !important; } }
/* Ready to renew's heading carries a "Print to PDF" button, so the heading row takes the h2's rule. */
.section-head { display:flex; align-items:center; justify-content:space-between; gap:var(--theme-spacing-medium);
  margin:var(--theme-spacing-2xl) 0 var(--theme-spacing-xs); padding-top:var(--theme-spacing-medium); border-top:1px solid var(--theme-divider-color-neutral-weak); }
.section-head h2 { margin:0; padding:0; border:0; }
.section-head .btn { margin:0; flex:none; }
.print-only { display:none; }
/* "Print to PDF" on Ready to renew: the page prints just the header and that list — every renewal
   group open, without the on-screen controls (Act column, comparisons, email-app note). */
@media print {
  @page { margin:14mm 12mm; }
  body.print-renew { background:#fff; }
  body.print-renew main { max-width:none; padding:0; }
  body.print-renew main > :not(.report-head):not(#panel-renew),
  body.print-renew #panel-renew > :not(.renew-print),
  body.print-renew .renew-print .no-print,
  body.print-renew .renew-print .acts,
  body.print-renew .renew-print .cmp-row,
  body.print-renew .renew-print .disc-icon { display:none !important; }
  body.print-renew .print-only { display:block; }
  body.print-renew .renew-print .section-head { margin-top:var(--theme-spacing-large); }
  body.print-renew .renew-print details.disclosure > summary { cursor:default; }
  body.print-renew .renew-print .truncate { white-space:normal; overflow:visible; text-overflow:clip; }
  body.print-renew .renew-print thead { display:table-header-group; }
  /* Column widths without the Act column (it's still counted by nth-child, just hidden). */
  body.print-renew table.renew-t th:nth-child(1) { width:25%; } body.print-renew table.renew-t th:nth-child(2) { width:13%; }
  body.print-renew table.renew-t th:nth-child(3) { width:15%; } body.print-renew table.renew-t th:nth-child(4) { width:29%; }
  body.print-renew table.renew-t th:last-child { width:18%; }
  body.print-renew table.renew-t.has-ppa th:nth-child(1) { width:21%; } body.print-renew table.renew-t.has-ppa th:nth-child(4) { width:22%; }
  body.print-renew table.renew-t.has-ppa th:nth-child(5) { width:11%; } body.print-renew table.renew-t.has-ppa th:last-child { width:18%; }
  body.print-renew .renew-print td:nth-child(3) { white-space:nowrap; }
  body.print-renew .renew-print .pill { max-width:none; white-space:nowrap; }
  body.print-renew .renew-print tr, body.print-renew .renew-print summary { break-inside:avoid; }
  body.print-renew .renew-print summary { break-after:avoid; }
  body.print-renew .report-head, body.print-renew .renew-print .pill { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
}
.card .k { font-size:var(--theme-heading-font-size-xs); font-weight:var(--theme-font-weight-heading-default); letter-spacing:var(--theme-heading-letter-spacing-xs); color:var(--fg); }
.card .v { font-size:var(--theme-heading-font-size-large); font-weight:var(--theme-font-weight-heading-default); letter-spacing:var(--theme-heading-letter-spacing-large);
  line-height:var(--theme-line-height-heading-large); margin:var(--theme-spacing-xs) 0; font-feature-settings:var(--theme-heading-font-feature-settings-numeric); }
.card .c { font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); color:var(--muted); }
.note { margin: 6px 0; }
/* Fine print: plain small muted text, as SaaS Manager shows notes (no box). */
.disclaimer { color:var(--muted); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); line-height:1.5; margin:var(--theme-spacing-small) 0; }
/* Callouts = Callout (card variant): severity tint + border, 16px severity icon, neutral text. */
.callout { --background:transparent; --border:var(--line); --icon:var(--fg);
  display:flex; gap:var(--theme-spacing-xs); margin:var(--theme-spacing-small) 0; padding:var(--theme-callout-padding);
  background:var(--background); border:var(--theme-callout-border-width) var(--theme-callout-border-style) var(--border);
  border-radius:var(--theme-callout-corner-radius); color:var(--theme-text-icon-neutral);
  font-size:var(--theme-font-size-body-medium); letter-spacing:var(--theme-letter-spacing-body-medium); line-height:1.5; }
.callout-icon { flex:none; width:16px; height:16px; margin-top:2px; fill:var(--icon); }
.callout-content { flex:1; min-width:0; }
.callout.informational { --background:var(--theme-callout-background-color-informational); --border:var(--theme-callout-border-color-informational); --icon:var(--theme-text-icon-brand); }
.callout.success { --background:var(--theme-callout-background-color-success); --border:var(--theme-callout-border-color-success); --icon:var(--theme-text-icon-success); }
.callout.warning { --background:var(--theme-callout-background-color-warning); --border:var(--theme-callout-border-color-warning); --icon:var(--theme-text-icon-warning); }
.callout.critical { --background:var(--theme-callout-background-color-critical); --border:var(--theme-callout-border-color-critical); --icon:var(--theme-text-icon-critical); }
.hint { color:var(--muted); font-weight:var(--theme-font-weight-body-default); font-size:var(--theme-font-size-body-medium); letter-spacing:var(--theme-letter-spacing-body-medium); }
.done-row td { opacity:.85; }
/* Pills = Pill: small text, fully rounded, truncates; neutral / informational / success / critical / attention. */
.pill { --background:var(--theme-pill-default-background-color); --color:var(--theme-pill-default-text-color);
  display:inline-block; max-width:100%; max-height:var(--theme-pill-max-height); vertical-align:middle;
  padding:var(--theme-pill-padding-vertical) var(--theme-spacing-xs); border-radius:999px;
  background:var(--background); color:var(--color);
  font-size:var(--theme-font-size-body-small); font-weight:var(--theme-font-weight-body-default);
  letter-spacing:var(--theme-letter-spacing-body-small); line-height:calc(var(--theme-pill-max-height) - 2 * var(--theme-pill-padding-vertical));
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pill.informational { --background:var(--theme-background-brand-weak); --color:var(--theme-text-icon-brand); }
.pill.success { --background:var(--theme-background-success-weak); --color:var(--theme-text-icon-success); }
.pill.critical { --background:var(--theme-background-critical-weak); --color:var(--theme-text-icon-critical); }
.pill.attention { --background:var(--theme-background-attention-weak); --color:var(--theme-text-icon-attention); }
.howto { color:var(--muted); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); }
/* Tables = Table: bordered rounded container, 12px cells with wider row ends, hairline row dividers. */
table { width:100%; border-collapse:separate; border-spacing:0; margin:var(--theme-spacing-small) 0 var(--theme-spacing-xs);
  background:var(--theme-table-background-color); color:var(--theme-table-text-color); font-size:var(--theme-table-font-size);
  border:var(--theme-table-border-width) var(--theme-table-border-style) var(--theme-table-border-color); border-radius:var(--theme-table-corner-radius); }
th, td { text-align:left; vertical-align:top; padding:var(--theme-spacing-small);
  border-bottom:var(--theme-table-border-width) var(--theme-table-border-style) var(--theme-table-cell-border-color); }
th:first-child, td:first-child { padding-inline-start:var(--theme-table-row-padding-inline); }
th:last-child, td:last-child { padding-inline-end:var(--theme-table-row-padding-inline); }
th { font-weight:var(--theme-font-weight-body-strong); vertical-align:bottom; }
tbody tr:last-child td { border-bottom:0; }
tbody tr:hover td { background:var(--theme-table-row-background-color-striped); }
tbody tr:last-child td:first-child { border-end-start-radius:var(--theme-table-corner-radius); }
tbody tr:last-child td:last-child { border-end-end-radius:var(--theme-table-corner-radius); }
td.r, th.r { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
ol.cands { margin:6px 0; padding-left:22px; } ol.cands li { margin:3px 0; }
.none { color:var(--muted); font-size:var(--theme-font-size-body-small); margin:var(--theme-spacing-xs) 0 0; }
code { background:var(--code); padding:1px var(--theme-spacing-2xs); border-radius:var(--theme-corner-radius-small);
  font-family:var(--mono); font-size:var(--theme-code-font-size-small); letter-spacing:var(--theme-code-letter-spacing-small);
  font-feature-settings:var(--theme-code-font-feature-settings); font-variant-ligatures:var(--theme-code-font-variant-ligatures); }
.more { color:var(--muted); font-size:var(--theme-font-size-body-small); }
/* Links = Text Link: brand colour, 1px underline offset 3px that fades on hover. Buttons are excluded. */
a:not(.btn, .tab, .card, .action-row) { color:var(--theme-text-icon-brand); text-decoration:underline; text-decoration-thickness:1px; text-underline-offset:3px;
  text-decoration-color:currentColor; transition:text-decoration-color .1s ease-in-out; font-feature-settings:var(--theme-text-link-font-feature-settings);
  border-radius:var(--theme-corner-radius-small); cursor:pointer; }
a:not(.btn, .tab, .card, .action-row):hover, a:not(.btn, .tab, .card, .action-row):active { text-decoration-color:transparent; }
a:not(.btn, .tab, .card, .action-row):focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); }
/* Form controls = Radio and Checkbox (16px). */
input[type="radio"], input[type="checkbox"] { appearance:none; -webkit-appearance:none; flex:none; margin:0; cursor:pointer;
  width:var(--theme-radio-width); height:var(--theme-radio-height); }
input[type="radio"] { border-radius:var(--theme-radio-corner-radius); background:var(--theme-radio-unchecked-enabled-background-color-default);
  border:var(--theme-radio-unchecked-border-width) var(--theme-radio-unchecked-border-style) var(--theme-radio-unchecked-enabled-border); }
input[type="radio"]:hover { background-color:var(--theme-radio-unchecked-enabled-background-color-hover); }
input[type="radio"]:checked { background-color:var(--theme-radio-checked-enabled-background-color-default);
  border:var(--theme-radio-checked-border-width) solid var(--theme-radio-checked-enabled-border-color-default); }
input[type="radio"]:checked:hover { border-color:var(--theme-radio-checked-enabled-border-color-hover); }
input[type="checkbox"] { width:var(--theme-checkbox-width); height:var(--theme-checkbox-height); border-radius:var(--theme-checkbox-corner-radius);
  border:var(--theme-checkbox-border-width) solid var(--theme-checkbox-unchecked-enabled-border-default);
  background:var(--theme-checkbox-unchecked-enabled-background-color-default) no-repeat center / 16px 16px; }
input[type="checkbox"]:hover { background-color:var(--theme-checkbox-unchecked-enabled-background-color-hover); }
input[type="checkbox"]:checked { border:none; background-color:var(--theme-checkbox-checked-enabled-background-color-default); background-image:${themeCheckmarkUrl()}; }
input[type="checkbox"]:checked:hover { background-color:var(--theme-checkbox-checked-enabled-background-color-hover); }
input[type="radio"]:focus-visible, input[type="checkbox"]:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); }
/* Action buttons sit side by side; in narrow windows they wrap instead of pushing the table off the page. */
td.acts { white-space:nowrap; }
@media (max-width: 1100px) { td.acts { white-space:normal; } }
/* Buttons = Button, medium size: primary / secondary / tertiary. Values are the theme's button
   tokens; the 1px border is drawn as an inset shadow. */
.btn { --background:transparent; --color:inherit; --border:transparent;
  display:inline-flex; align-items:center; justify-content:center; position:relative; vertical-align:middle;
  height:var(--theme-button-height-medium); padding-inline:var(--theme-spacing-xs); margin:2px var(--theme-spacing-2xs) 2px 0;
  font-family:inherit; font-size:var(--theme-button-font-size-medium); font-weight:var(--theme-button-font-weight); line-height:1;
  background:var(--background); color:var(--color); box-shadow:0 0 0 1px inset var(--border);
  border:0; border-radius:var(--theme-button-corner-radius); text-decoration:none; white-space:nowrap; cursor:pointer; }
.btn:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); }
.btn:disabled, .btn[aria-disabled="true"] { opacity:.5; cursor:default; }
.btn.primary { --background:var(--theme-button-background-color-primary-default); --color:var(--theme-button-text-icon-color-primary-default); --border:var(--theme-button-border-color-primary); }
.btn.primary:hover { --background:var(--theme-button-background-color-primary-hover); --color:var(--theme-button-text-icon-color-primary-hover); }
.btn.primary:active { --background:var(--theme-button-background-color-primary-pressed); --color:var(--theme-button-text-icon-color-primary-pressed); }
.btn.secondary { --background:var(--theme-button-background-color-secondary-default); --color:var(--theme-button-text-icon-color-secondary-default); --border:var(--theme-button-border-color-secondary); }
.btn.secondary:hover { --background:var(--theme-button-background-color-secondary-hover); --color:var(--theme-button-text-icon-color-secondary-hover); }
.btn.secondary:active { --background:var(--theme-button-background-color-secondary-pressed); --color:var(--theme-button-text-icon-color-secondary-pressed); }
.btn.tertiary { --background:var(--theme-button-background-color-tertiary-default); --color:var(--theme-button-text-icon-color-tertiary-default); --border:var(--theme-button-border-color-tertiary); }
.btn.tertiary:hover { --background:var(--theme-button-background-color-tertiary-hover); --color:var(--theme-button-text-icon-color-tertiary-hover); }
.btn.tertiary:active { --background:var(--theme-button-background-color-tertiary-pressed); --color:var(--theme-button-text-icon-color-tertiary-pressed); }
/* Renewal groups = Disclosure (base): a trigger with a chevron, right when closed, down when open. */
details.disclosure { margin:var(--theme-spacing-medium) 0; }
details.disclosure > summary { display:flex; align-items:center; gap:var(--theme-spacing-xs); list-style:none; cursor:pointer;
  padding:var(--theme-spacing-2xs) var(--theme-spacing-2xs); margin:0 calc(-1 * var(--theme-spacing-2xs)); border-radius:var(--theme-corner-radius-small);
  font-size:var(--theme-heading-font-size-small); font-weight:var(--theme-font-weight-heading-default); letter-spacing:var(--theme-heading-letter-spacing-small); }
details.disclosure > summary::-webkit-details-marker { display:none; }
details.disclosure > summary:hover { background:var(--theme-background-transparent-hover); }
details.disclosure > summary:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); }
.disc-icon { width:16px; height:16px; flex:none; background:var(--theme-text-icon-neutral); transform:rotate(-90deg); transition:transform .15s ease;
  -webkit-mask:${themeIconMask("chevron")} center / 16px 16px no-repeat; mask:${themeIconMask("chevron")} center / 16px 16px no-repeat; }
details.disclosure[open] > summary .disc-icon { transform:none; }
.about-body { color:var(--muted); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); max-width:820px; padding:0 0 0 calc(16px + var(--theme-spacing-xs)); }
.about-body p { margin:var(--theme-spacing-xs) 0; }
.disc-meta { color:var(--muted); font-size:var(--theme-font-size-body-medium); font-weight:var(--theme-font-weight-body-default); letter-spacing:var(--theme-letter-spacing-body-medium); }
/* Fixed columns, so every renewal group's table lines up. */
table.renew-t { table-layout:fixed; }
/* Act is sized for "Renew on Marketplace ↗" + "Compare" side by side. */
table.renew-t th:nth-child(1) { width:17%; } table.renew-t th:nth-child(2) { width:10%; } table.renew-t th:nth-child(3) { width:11%; }
table.renew-t th:nth-child(4) { width:20%; } table.renew-t th:nth-last-child(2) { width:29%; } table.renew-t th:last-child { width:13%; }
table.renew-t.has-ppa th:nth-child(1) { width:15%; } table.renew-t.has-ppa th:nth-child(5) { width:8%; } table.renew-t.has-ppa th:nth-child(4) { width:14%; }
table.renew-t td.acts { overflow:hidden; }
table.renew-t > tbody > tr > td { vertical-align:middle; }
table.renew-t .pill { max-width:100%; }
/* A comparison opened under its row. */
tr.cmp-row > td { background:var(--theme-background-neutral); padding-top:var(--theme-spacing-medium); padding-bottom:var(--theme-spacing-medium); }
tbody tr.cmp-row:hover > td { background:var(--theme-background-neutral); }
.cmp-title { margin:0 0 var(--theme-spacing-xs); }
.btn[aria-expanded="true"] { --background:var(--theme-button-background-color-secondary-pressed); }
table.notmp-t { max-width:640px; }
.nc-t + .btn { margin-top:var(--theme-spacing-2xs); }
table.cmp-t th { vertical-align:top; }
td.cmp-lbl { color:var(--muted); font-weight:var(--theme-font-weight-body-strong); white-space:nowrap; }
.seedstar { color:var(--warn); }
/* §2 interactive selection — radio groups, sticky action bar, status pill, fallback pre. */
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.sel-bar { display:flex; flex-wrap:wrap; gap:var(--theme-spacing-small); align-items:center; justify-content:space-between;
  background:var(--panel); border-radius:var(--theme-card-corner-radius); box-shadow:var(--theme-card-elevation);
  padding:var(--theme-spacing-small) var(--theme-spacing-medium); margin:var(--theme-spacing-small) 0 var(--theme-spacing-medium); }
.sel-bar.sticky { position:sticky; top:0; z-index:10; }
.sel-bar-text { color:var(--muted); }
.sel-bar-actions { display:flex; align-items:center; gap:var(--theme-spacing-xs); flex-wrap:wrap; }
.sel-bar .btn { margin:0; }
/* Save status = a Pill (neutral; success once saved/copied) that fades in. */
.sel-status { display:inline-block; max-height:var(--theme-pill-max-height); padding:var(--theme-pill-padding-vertical) var(--theme-spacing-xs);
  border-radius:var(--theme-corner-radius-circular); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small);
  line-height:calc(var(--theme-pill-max-height) - 2 * var(--theme-pill-padding-vertical));
  background:var(--theme-pill-default-background-color); color:var(--theme-pill-default-text-color); opacity:0;
  transition:opacity .18s ease; pointer-events:none; }
.sel-status.show { opacity:1; }
.sel-status.ok { background:var(--theme-background-success-weak); color:var(--theme-text-icon-success); }
.sel-howto { color:var(--muted); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); margin:0 0 var(--theme-spacing-xs); }
p.stale { color:var(--muted); font-size:var(--theme-font-size-body-small); margin:var(--theme-spacing-xs) 0 0; }
/* Two-line table cells, as in SaaS Manager lists: name, then muted detail. */
.cell-main { font-weight:var(--theme-font-weight-body-strong); }
.cell-sub { color:var(--muted); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); }
.contract-hint { font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); }
.truncate { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.contract-hint, .cell-sub { display:block; }
/* Fixed columns so long names truncate to one line instead of growing the row. */
table.confirm-t { table-layout:fixed; }
table.confirm-t td { vertical-align:middle; }
table.confirm-t th:nth-child(1) { width:26%; } table.confirm-t th:nth-child(2) { width:11%; } table.confirm-t th:nth-child(3) { width:10%; }
table.confirm-t th:nth-child(4) { width:22%; } table.confirm-t th:nth-child(5) { width:31%; }
.view-listing { display:inline-block; margin-top:var(--theme-spacing-2xs); font-size:var(--theme-font-size-body-small); }
/* Product choice = Select (medium): a field with the indicator-chevron-down icon. The open
   option list is the browser's own; the closed control matches the theme. */
.select-wrap { position:relative; display:flex; width:100%; }
.select-wrap::after { content:""; position:absolute; top:50%; right:var(--theme-select-padding-horizontal); width:16px; height:16px;
  transform:translateY(-50%); pointer-events:none; background:var(--theme-text-icon-neutral);
  -webkit-mask:${themeIconMask("chevron")} center / 16px 16px no-repeat; mask:${themeIconMask("chevron")} center / 16px 16px no-repeat; }
select.theme-select { appearance:none; -webkit-appearance:none; width:100%; min-width:0; height:var(--theme-field-size-medium); margin:0;
  padding:0 calc(var(--theme-select-padding-horizontal) + 16px + var(--theme-spacing-2xs)) 0 var(--theme-select-padding-horizontal);
  border:var(--theme-field-border-default); border-radius:var(--theme-select-corner-radius); box-shadow:var(--theme-field-box-shadow-default);
  background:var(--theme-field-background-color-default); color:var(--theme-field-text-color-default);
  font:inherit; font-size:var(--theme-field-font-size-small); font-weight:var(--theme-field-font-weight); text-overflow:ellipsis; cursor:pointer; }
select.theme-select:hover { background-color:var(--theme-select-background-color-hover); }
select.theme-select:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); }
select.theme-select:invalid { color:var(--theme-field-placeholder-text-color); }
select.theme-select option { color:var(--theme-field-text-color-default); background:var(--theme-field-background-color-default); }
/* Lead email: one-time email-app chooser + "opens in …" note. */
/* Email-app chooser = Menu in a Popover: 28px items, highlighted item in brand fill. */
.mail-chooser:focus { outline:none; }
.mail-chooser { position:absolute; z-index:20; min-width:220px; max-width:var(--theme-popover-max-width);
  background:var(--theme-popover-background-color); border-radius:var(--theme-popover-corner-radius); box-shadow:var(--theme-popover-elevation);
  padding:var(--theme-spacing-2xs) 0; display:flex; flex-direction:column; gap:var(--theme-spacing-hairline); }
.mail-chooser .mc-title { margin:0; padding:var(--theme-spacing-2xs) var(--theme-spacing-small); color:var(--theme-menu-item-secondary-label-text-color-default);
  font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); }
.mail-chooser .mc-opt { display:flex; flex-direction:column; justify-content:center; align-items:flex-start; min-height:28px; margin:0 var(--theme-spacing-2xs); padding:0 var(--theme-spacing-small);
  border:0; border-radius:var(--theme-menu-item-corner-radius); background:transparent; color:var(--theme-menu-item-label-text-color-default);
  font:inherit; font-size:var(--theme-font-size-body-medium); text-align:left; cursor:pointer; outline:none; }
.mail-chooser .mc-opt:focus { background:var(--theme-menu-item-background-color-highlighted); color:var(--theme-menu-item-label-text-color-highlighted); }
.mail-chooser .mc-opt.mc-two { padding-top:var(--theme-spacing-2xs); padding-bottom:var(--theme-spacing-2xs); }
.mail-chooser .mc-sub { color:var(--theme-menu-item-secondary-label-text-color-default); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); }
.mail-chooser .mc-opt:focus .mc-sub { color:inherit; opacity:.85; }
.mail-chooser .mc-divider { height:0; margin:var(--theme-spacing-2xs) 0; border-top:1px solid var(--theme-menu-group-divider-border-color); }
/* "Already on Marketplace" toggle: a tertiary text button under the row's actions. */
button.mark-mp { display:block; margin:var(--theme-spacing-2xs) 0 0; padding:0; border:0; background:none; font:inherit; cursor:pointer;
  font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); color:var(--muted); text-decoration:underline; text-underline-offset:2px; }
button.mark-mp:hover { color:var(--theme-text-icon-default, inherit); }
button.mark-mp:focus-visible { outline:var(--theme-focus-outline); outline-offset:var(--theme-focus-offset); }
button.mark-mp[aria-pressed="true"] { color:var(--theme-text-icon-success); text-decoration:none; font-weight:600; }
td button.mark-mp { white-space:normal; text-align:left; }
tr.mark-pending > td { background:var(--theme-background-success-weak); }
/* After a draft opens: where it went, and a one-click way to switch apps (a Toast). */
.mail-toast { position:fixed; left:50%; bottom:var(--theme-spacing-large); transform:translateX(-50%); z-index:30; display:flex; gap:var(--theme-spacing-small); align-items:center;
  max-width:min(560px, calc(100vw - 32px)); padding:var(--theme-spacing-xs) var(--theme-spacing-small); border-radius:var(--theme-popover-corner-radius);
  background:var(--theme-popover-background-color); box-shadow:var(--theme-popover-elevation); font-size:var(--theme-font-size-body-small); }
.mail-toast .btn { margin:0; white-space:nowrap; }
.mail-chooser .mc-remember { display:flex; gap:var(--theme-spacing-xs); align-items:center; margin:var(--theme-spacing-2xs) var(--theme-spacing-small) 0;
  padding:var(--theme-spacing-xs) 0 var(--theme-spacing-2xs); border-top:1px solid var(--theme-menu-group-divider-border-color);
  font-size:var(--theme-font-size-body-small); color:var(--muted); cursor:pointer; }
p.mail-pref { color:var(--muted); font-size:var(--theme-font-size-body-small); letter-spacing:var(--theme-letter-spacing-body-small); margin:var(--theme-spacing-2xs) 0 var(--theme-spacing-xs); }
pre.sel-dump { background:var(--code); border:1px solid var(--line); border-radius:var(--theme-corner-radius-medium); padding:var(--theme-spacing-small);
  margin:var(--theme-spacing-small) 0 0; font-family:var(--mono); font-size:var(--theme-code-font-size-small); white-space:pre-wrap; word-break:break-all; max-height:260px; overflow:auto; }
`;

/** Theme tokens (light + dark), embedded so the report stays a single self-contained file. */
// Dark mode applies on screen only: a printed or saved-as-PDF page is always light.
const THEME_TOKENS = readFileSync(fileURLToPath(new URL("./theme/tokens.css", import.meta.url)), "utf8")
  .replace("@media (prefers-color-scheme: dark)", "@media screen and (prefers-color-scheme: dark)");

/**
 * §2 interactive selection — collects every pending app's radio group and
 * exports a selections.json compatible with the existing pipeline
 * (same schema as `src/mcpServer.ts` record_product_selection: either
 * `{listingId}` or `{none:true}` per app). The `__NONE__` sentinel is a
 * JS-only convention inside the HTML; the exported JSON uses `{none:true}`.
 * Starts from any prior selections baked into the page as window.__priorSelections__
 * so re-saving across rounds never wipes previously-confirmed apps.
 * No deps, no network — Blob download + clipboard with execCommand fallback.
 */
const SCRIPT = `
(function () {
  function ready(fn){ if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  // Clipboard API first; on file:// it can be unavailable, so fall back to a hidden
  // textarea + execCommand. Calls done(true|false).
  function copyToClipboard(text, done) {
    function fallback() {
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { ok = !!(document.execCommand && document.execCommand('copy')); } catch (_) { ok = false; }
        document.body.removeChild(ta);
      } catch (_) { ok = false; }
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  // Lead emails ("Renew on Marketplace" / "Get in touch") are one button. A page
  // can't tell which email client the buyer uses, so the first click asks (Gmail,
  // Outlook, Outlook.com, or the default mail app) and the choice is remembered in
  // this browser; later clicks open the pre-filled draft straight away. The link's
  // own mailto: is the single source of recipient / subject / body.
  var MAIL_PREF = 'consolidation-agent.mailClient';
  var MAIL_NAMES = { gmail: 'Gmail', outlook: 'Outlook on the web', outlookcom: 'Outlook.com', 'default': 'your desktop email app' };
  var enc = encodeURIComponent;
  var COMPOSE = {
    // Gmail: tf=cm opens the compose window (the older view=cm now just loads the
    // inbox). /u/0/ = the first signed-in Google account.
    gmail: function (m) { return 'https://mail.google.com/mail/u/0/?to=' + enc(m.to) + '&su=' + enc(m.subject) + '&body=' + enc(m.body) + '&tf=cm'; },
    outlook: function (m) { return 'https://outlook.office.com/mail/deeplink/compose?to=' + enc(m.to) + '&subject=' + enc(m.subject) + '&body=' + enc(m.body); },
    outlookcom: function (m) { return 'https://outlook.live.com/mail/0/deeplink/compose?to=' + enc(m.to) + '&subject=' + enc(m.subject) + '&body=' + enc(m.body); }
  };
  function mailtoParts(mailto) {
    var rest = mailto.replace(/^mailto:/i, '');
    var q = rest.indexOf('?');
    var m = { to: decodeURIComponent(q < 0 ? rest : rest.slice(0, q)), subject: '', body: '' };
    (q < 0 ? '' : rest.slice(q + 1)).split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      var k = (i < 0 ? kv : kv.slice(0, i)).toLowerCase();
      var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
      if (k === 'subject') m.subject = v; else if (k === 'body') m.body = v;
    });
    return m;
  }
  function getMailPref() { try { var v = localStorage.getItem(MAIL_PREF); return MAIL_NAMES[v] ? v : null; } catch (_) { return null; } }
  function setMailPref(v) { try { if (v) localStorage.setItem(MAIL_PREF, v); else localStorage.removeItem(MAIL_PREF); } catch (_) {} }
  function openDraft(client, mailto) {
    if (!COMPOSE[client]) { window.location.href = mailto; return; }
    window.open(COMPOSE[client](mailtoParts(mailto)), '_blank', 'noopener');
  }
  // Plain-text copy of the email, for when no email app opens (e.g. no desktop app is
  // set to handle email links, or the mailbox isn't one of the web apps listed).
  function emailText(mailto) {
    var m = mailtoParts(mailto);
    return 'To: ' + m.to + '\\nSubject: ' + m.subject + '\\n\\n' + m.body;
  }

  ready(function () {
    var chooser = document.getElementById('mail-chooser');
    var prefNote = document.getElementById('mail-pref');
    function showPrefNote() {
      if (!prefNote) return;
      var p = getMailPref();
      prefNote.hidden = !p;
      if (p) prefNote.querySelector('[data-mail-name]').textContent = MAIL_NAMES[p];
    }
    function hideChooser() { if (chooser) chooser.hidden = true; }
    var toast = document.getElementById('mail-toast');
    var lastLink = null;
    function showToast(text, offerChange) {
      if (!toast) return;
      toast.querySelector('[data-toast-text]').textContent = text;
      toast.querySelector('[data-mail-change]').hidden = !offerChange;
      toast.hidden = false;
      if (toast._t) clearTimeout(toast._t);
      toast._t = setTimeout(function () { toast.hidden = true; }, 12000);
    }
    function opened(client) {
      showToast('Opening the email in ' + MAIL_NAMES[client] + '. Nothing opened, or wrong account?', true);
    }
    function showChooser(link, viaKeyboard) {
      if (!chooser) { window.location.href = link.getAttribute('href'); return; }
      chooser._mailto = link.getAttribute('href');
      chooser.hidden = false;
      var r = link.getBoundingClientRect();
      var w = chooser.offsetWidth;
      var left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 8));
      chooser.style.left = left + 'px';
      chooser.style.top = (r.bottom + window.scrollY + 6) + 'px';
      // Menu: opened by keyboard, the first item is highlighted; opened by pointer, none is
      // until the pointer moves over one (focus sits on the menu so the arrow keys still work).
      var first = chooser.querySelector('.mc-opt');
      if (viaKeyboard && first) first.focus(); else chooser.focus();
    }
    showPrefNote();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideChooser(); return; }
      // Menu keyboard behaviour: Up/Down move between items (wrapping), Home/End jump.
      if (!chooser || chooser.hidden) return;
      var opts = [].slice.call(chooser.querySelectorAll('.mc-opt'));
      var i = opts.indexOf(document.activeElement);
      var next = e.key === 'ArrowDown' ? (i + 1) % opts.length : e.key === 'ArrowUp' ? (i - 1 + opts.length) % opts.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); opts[next].focus(); }
    });
    // Menu: pointing at an item highlights it by moving focus there, so only one item is ever highlighted.
    if (chooser) chooser.addEventListener('mouseover', function (e) {
      var o = e.target && e.target.closest ? e.target.closest('.mc-opt') : null;
      if (o && document.activeElement !== o) o.focus();
    });
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      var link = t.closest('a.lead-mail');
      if (link) {
        e.preventDefault();
        var pref = getMailPref();
        lastLink = link;
        if (pref) { hideChooser(); openDraft(pref, link.getAttribute('href')); opened(pref); }
        else showChooser(link, e.detail === 0); // detail 0 = activated with Enter, not a mouse click
        return;
      }
      // From the toast: pick a different email app for the same email.
      if (t.closest('[data-mail-change]')) {
        if (toast) toast.hidden = true;
        if (lastLink) showChooser(lastLink, e.detail === 0);
        return;
      }
      if (t.closest('[data-toast-close]')) { if (toast) toast.hidden = true; return; }
      var opt = t.closest('#mail-chooser .mc-opt');
      if (opt) {
        var client = opt.getAttribute('data-client');
        if (client === 'copy') {
          hideChooser();
          copyToClipboard(emailText(chooser._mailto), function (ok) {
            showToast(ok ? 'Email copied. Paste it into a new email in any app.' : 'Copy failed. Choose an email app instead.', !ok);
          });
          return;
        }
        var remember = chooser.querySelector('.mc-remember input');
        if (!remember || remember.checked) setMailPref(client);
        hideChooser();
        showPrefNote();
        openDraft(client, chooser._mailto);
        opened(client);
        return;
      }
      if (t.closest('[data-mail-reset]')) { e.preventDefault(); setMailPref(null); showPrefNote(); return; }
      // Clicking away closes the chooser.
      if (!t.closest('#mail-chooser')) hideChooser();
    });

    // "View listing" follows the chosen product (hidden for "None of these").
    document.addEventListener('change', function (e) {
      var sel = e.target;
      if (!sel || !sel.matches || !sel.matches('select[data-app-name]')) return;
      updatePickCount();
      var link = sel.closest('td') && sel.closest('td').querySelector('.view-listing');
      if (!link) return;
      var opt = sel.options[sel.selectedIndex];
      var url = opt && opt.getAttribute('data-url');
      if (url) { link.href = url; link.hidden = false; } else { link.hidden = true; }
    });
    // A pick in the dropdown isn't applied until the agent records it, so say so as soon as one is made.
    function updatePickCount() {
      var marks = Object.keys(buildMarks()).length;
      var picks = 0;
      var selects = document.querySelectorAll('select[data-app-name]');
      for (var i = 0; i < selects.length; i++) if (selects[i].value) picks++;
      var n = picks + marks;
      var texts = document.querySelectorAll('[data-sel-text]');
      for (var j = 0; j < texts.length; j++) {
        texts[j].textContent = n
          ? n + (n === 1 ? ' change' : ' changes') + ' on this page, not applied yet. Click Copy for your agent and paste it into the chat to apply ' + (n === 1 ? 'it' : 'them') + '.'
          : "Pick a product for each application. Picks aren't applied until you give them to your agent.";
      }
      var auto = document.querySelectorAll('[data-autohide]');
      for (var k = 0; k < auto.length; k++) auto[k].hidden = n === 0;
    }
    // "Already on Marketplace": the row moves to the Already on Marketplace tab straight away and
    // every total on the page is recalculated. The mark itself is applied through the agent, like picks.
    var TOT = window.__totals__ || null;
    function bigUsd(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n); }
    function setStat(key, text) {
      var els = document.querySelectorAll('[data-stat="' + key + '"]');
      for (var i = 0; i < els.length; i++) els[i].textContent = text;
    }
    function recalc() {
      if (!TOT) return;
      var t = JSON.parse(JSON.stringify(TOT));
      var moved = document.querySelectorAll('tr[data-move][data-moved]');
      for (var i = 0; i < moved.length; i++) {
        var r = moved[i], acv = Number(r.getAttribute('data-acv')) || 0, b = t[r.getAttribute('data-move')];
        if (b) { b.n--; b.usd -= acv; }
        t.already.n++; t.already.usd += acv;
        if (r.hasAttribute('data-soon')) { t.soon.n--; t.soon.usd -= acv; }
        if (r.hasAttribute('data-ppa')) { t.ppa.n--; t.ppa.usd -= acv; }
      }
      ['already', 'ready', 'soon', 'ppa', 'confirm'].forEach(function (k) {
        setStat(k + '-n', t[k].n.toLocaleString());
        setStat(k + '-usd', bigUsd(t[k].usd));
        var shows = document.querySelectorAll('[data-stat-show="' + k + '-n"]');
        for (var j = 0; j < shows.length; j++) shows[j].hidden = t[k].n <= 0;
      });
      setStat('tab-already', t.already.n.toLocaleString());
      setStat('tab-renew', t.ready.n.toLocaleString());
      setStat('tab-confirm', t.confirm.n.toLocaleString());
      // Renewal groups: recount what's left in each; hide a group that's now empty.
      var groups = document.querySelectorAll('details[data-renew-group]');
      for (var g = 0; g < groups.length; g++) {
        var rows = groups[g].querySelectorAll('tr[data-move]:not([data-moved])'), n = 0, usd = 0;
        for (var k = 0; k < rows.length; k++) { n++; usd += Number(rows[k].getAttribute('data-acv')) || 0; }
        var pn = groups[g].querySelector('[data-group-n]'), pu = groups[g].querySelector('[data-group-usd]');
        if (pn) pn.textContent = n;
        if (pu) pu.textContent = bigUsd(usd);
        groups[g].hidden = n === 0;
      }
      var table = document.querySelector('table.already-t'), empty = document.querySelector('.already-empty');
      var any = table && table.querySelector('tbody tr');
      if (table) table.hidden = !any;
      if (empty) empty.hidden = !!any;
    }
    function moveToAlready(b) {
      var row = b.closest('tr[data-move]');
      var tbody = document.querySelector('table.already-t tbody');
      if (!row || !tbody) return false;
      var app = b.getAttribute('data-mark-app');
      var acv = Number(row.getAttribute('data-acv')) || 0;
      row.setAttribute('data-moved', '');
      row.hidden = true;
      var cmp = row.nextElementSibling;
      if (cmp && cmp.classList.contains('cmp-row')) cmp.hidden = true;
      b.setAttribute('aria-pressed', 'true');
      var tr = document.createElement('tr');
      tr.className = 'done-row mark-pending';
      tr._from = row;
      tr.innerHTML = '<td></td><td class="r"></td><td class="r">—</td><td>—</td>'
        + '<td><span class="pill">Marked by you · not applied yet</span> <button type="button" class="mark-mp" data-unmove>Not on Marketplace? Undo</button></td>';
      tr.cells[0].textContent = app;
      tr.cells[1].textContent = '$' + acv.toLocaleString();
      // Keep the table in ACV order.
      var rows = tbody.querySelectorAll('tr'), before = null;
      for (var i = 0; i < rows.length; i++) {
        var v = rows[i]._from ? Number(rows[i]._from.getAttribute('data-acv')) : Number(rows[i].getAttribute('data-acv'));
        if (acv > (v || 0)) { before = rows[i]; break; }
      }
      tbody.insertBefore(tr, before);
      return true;
    }
    function moveBack(btn) {
      var tr = btn.closest('tr'), row = tr && tr._from;
      if (!row) return;
      tr.parentNode.removeChild(tr);
      row.removeAttribute('data-moved');
      row.hidden = false;
      var b = row.querySelector('button.mark-mp');
      if (b) b.setAttribute('aria-pressed', 'false');
    }
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button.mark-mp') : null;
      if (!b) return;
      if (b.hasAttribute('data-unmove')) { moveBack(b); recalc(); updatePickCount(); moveToast(b, false); return; }
      var on = b.getAttribute('aria-pressed') !== 'true';
      if (on && !b.hasAttribute('data-marked') && moveToAlready(b)) { recalc(); updatePickCount(); moveToast(b, true); return; }
      // Already marked when the report was generated: the undo is applied by the agent, which moves
      // it back to the right section when the report is regenerated.
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (!b._label) b._label = b.textContent;
      b.textContent = on ? 'Will move back (not applied yet) · Undo' : b._label;
      var row = b.closest('tr');
      if (row) row.classList.toggle('mark-pending', on);
      updatePickCount();
    });
    // A short note where the row was, since it has just left the table.
    function moveToast(b, moved) {
      var el = document.getElementById('move-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'move-toast';
        el.className = 'mail-toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        document.body.appendChild(el);
      }
      var app = b.getAttribute('data-mark-app') || (b.closest('tr') && b.closest('tr').cells[0].textContent) || 'Application';
      el.textContent = moved
        ? app + ' moved to Already on Marketplace. Totals updated; click Copy for your agent to apply it.'
        : app + ' moved back. Totals updated.';
      el.hidden = false;
      if (el._t) clearTimeout(el._t);
      el._t = setTimeout(function () { el.hidden = true; }, 5000);
    }

    var bars = document.querySelectorAll('[data-action-bar]');
    if (!bars.length) return;
    var dump = document.getElementById('sel-dump');

    function buildSelections() {
      var out = Object.assign({}, (window.__priorSelections__ || {}));
      // One Select per pending application; an untouched one (value "") adds nothing.
      var selects = document.querySelectorAll('select[data-app-name]');
      for (var i = 0; i < selects.length; i++) {
        var name = selects[i].getAttribute('data-app-name');
        var v = selects[i].value;
        if (!name || !v) continue;
        out[name] = v === '__NONE__' ? { none: true } : { listingId: v };
      }
      return out;
    }
    // Already on Marketplace marks made on this page: app -> true (mark) / false (undo a mark).
    function buildMarks() {
      var out = {};
      var btns = document.querySelectorAll('button.mark-mp[aria-pressed="true"]');
      for (var i = 0; i < btns.length; i++) out[btns[i].getAttribute('data-mark-app')] = !btns[i].hasAttribute('data-marked');
      return out;
    }
    // What "Copy for your agent" hands over: product picks and marks in one object. A mark wins
    // over a product pick for the same application.
    function buildChanges() {
      var out = buildSelections();
      var marks = buildMarks();
      Object.keys(marks).forEach(function (app) { out[app] = { alreadyOnMarketplace: marks[app] }; });
      return out;
    }

    function showStatus(bar, text, kind) {
      bars.forEach(function (b) {
        var pill = b.querySelector('[data-status]');
        if (!pill) return;
        pill.textContent = text;
        pill.className = 'sel-status show' + (kind ? ' ' + kind : '');
        if (pill._t) clearTimeout(pill._t);
        pill._t = setTimeout(function () { pill.className = 'sel-status'; }, 4000);
      });
    }

    function download(json) {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'selections.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }

    function copyText(json, bar) {
      copyToClipboard(json, function (ok) {
        if (ok) { showStatus(bar, 'Copied. Paste it into your agent', 'ok'); return; }
        if (dump) {
          dump.textContent = json;
          dump.hidden = false;
          showStatus(bar, 'Copy manually below', 'warn');
        } else {
          showStatus(bar, 'Copy failed', 'warn');
        }
      });
    }

    bars.forEach(function (bar) {
      var dlBtn = bar.querySelector('[data-action="download"]');
      var cpBtn = bar.querySelector('[data-action="copy"]');
      if (dlBtn) dlBtn.addEventListener('click', function () {
        var sel = buildSelections();
        var marks = buildMarks();
        Object.keys(marks).forEach(function (app) { delete sel[app]; });
        if (!Object.keys(sel).length) { showStatus(bar, Object.keys(marks).length ? 'Use Copy for your agent to apply marks' : 'Pick at least one option', 'warn'); return; }
        download(JSON.stringify(sel, null, 2));
        showStatus(bar, 'Saved', 'ok');
      });
      if (cpBtn) cpBtn.addEventListener('click', function () {
        var sel = buildChanges();
        if (!Object.keys(sel).length) { showStatus(bar, 'Make a change first', 'warn'); return; }
        copyText('Apply my changes from the AWS Marketplace Consolidation Insights dashboard:\\n' + JSON.stringify(sel, null, 2), bar);
      });
    });
  });

  // "Compare" opens/closes the comparison row under its application; "Show N more" reveals the rest of a table.
  function setCompare(row, open) {
    row.hidden = !open;
    var btn = document.querySelector('[data-cmp-toggle="' + row.id + '"]');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  ready(function () {
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      var cmp = t.closest('[data-cmp-toggle]');
      if (cmp) {
        var row = document.getElementById(cmp.getAttribute('data-cmp-toggle'));
        if (row) setCompare(row, row.hidden);
        return;
      }
      var more = t.closest('[data-show-more]');
      if (more) {
        var table = more.previousElementSibling;
        if (table) [].forEach.call(table.querySelectorAll('tr.more-row'), function (r) { r.hidden = false; });
        more.parentNode.removeChild(more);
      }
    });
  });

  // "Print to PDF" on Ready to renew: print only that list (see body.print-renew in the CSS), with
  // every renewal group open; the groups the viewer had closed close again afterwards.
  ready(function () {
    var btn = document.querySelector('[data-print-renew]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var closed = [].slice.call(document.querySelectorAll('.renew-print details:not([open])'));
      var title = document.title;
      var done = false;
      function restore() {
        if (done) return;
        done = true;
        document.body.classList.remove('print-renew');
        closed.forEach(function (d) { d.open = false; });
        document.title = title;
        window.removeEventListener('afterprint', restore);
      }
      closed.forEach(function (d) { d.open = true; });
      document.body.classList.add('print-renew');
      // The title becomes the suggested PDF file name.
      document.title = 'Ready to renew on AWS Marketplace · ' + title;
      window.addEventListener('afterprint', restore);
      window.print();
    });
  });

  // Report tabs (Tabs). The URL hash names the open tab (#renew), so tabs can be linked and
  // the back button works; a hash naming an element inside a panel (#cmp-…) opens that panel and
  // scrolls to it. Arrow keys / Home / End move between tabs, as usual. "Show all sections"
  // reveals every panel (printing always does). Without JS every panel simply stays visible.
  ready(function () {
    var tabs = [].slice.call(document.querySelectorAll('.tabs [role="tab"]'));
    if (!tabs.length) return;
    var ids = tabs.map(function (t) { return t.getAttribute('data-tab'); });
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
    var bar = document.querySelector('.tabs-bar');
    var allBtn = document.querySelector('[data-show-all]');
    var showAll = false, currentTab = ids[0];

    function render(id) {
      currentTab = id;
      tabs.forEach(function (t, i) {
        var on = ids[i] === id;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        if (panels[i]) panels[i].hidden = !showAll && !on;
      });
    }
    function resolve(hash) {
      if (ids.indexOf(hash) >= 0) return { tab: hash };
      var el = hash ? document.getElementById(hash) : null;
      var panel = el && el.closest ? el.closest('[role="tabpanel"]') : null;
      if (panel) return { tab: panel.id.replace(/^panel-/, ''), target: el };
      return { tab: ids[0] };
    }
    function bringIntoView(r) {
      if (r.target) { r.target.scrollIntoView({ block: 'start' }); return; }
      if (showAll) { var p = document.getElementById('panel-' + r.tab); if (p) p.scrollIntoView({ block: 'start' }); return; }
      if (bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: 'start' });
    }
    function go(hash) {
      var r = resolve(hash);
      render(r.tab);
      if (r.target) reveal(r.target);
      bringIntoView(r);
    }
    // A link to something inside a closed renewal group or a closed comparison opens it first.
    function reveal(el) {
      var d = el.closest ? el.closest('details') : null;
      if (d) d.open = true;
      if (el.classList && el.classList.contains('cmp-row')) setCompare(el, true);
    }
    function hash() { try { return decodeURIComponent(location.hash.slice(1)); } catch (_) { return ''; } }

    // Navigation never depends on the URL: sections switch directly, and the URL (#renew) is only
    // updated where the viewer allows it, so links can be shared and the back button works. Some
    // viewers (embedded previews, sandboxed pages) refuse URL changes; there the tabs still work.
    function setUrl(id, replace) {
      try { history[replace ? 'replaceState' : 'pushState'](null, '', '#' + id); } catch (_) { /* URL updates not allowed here */ }
    }
    window.addEventListener('hashchange', function () { go(hash()); });
    window.addEventListener('popstate', function () { go(hash()); });
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[data-tab]') : null;
      if (!a) return;
      e.preventDefault();
      var id = a.getAttribute('data-tab');
      go(id);
      if (hash() !== id) setUrl(id, false);
    });
    document.querySelector('.tabs').addEventListener('keydown', function (e) {
      var i = ids.indexOf(currentTab);
      var n = e.key === 'ArrowRight' ? (i + 1) % ids.length : e.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
      if (n < 0) return;
      e.preventDefault();
      render(ids[n]);
      setUrl(ids[n], true);
      tabs[n].focus();
    });
    if (allBtn) allBtn.addEventListener('click', function () {
      showAll = !showAll;
      allBtn.setAttribute('aria-pressed', showAll ? 'true' : 'false');
      allBtn.textContent = showAll ? 'Show one' : 'Show all';
      render(currentTab);
    });
    var initial = resolve(hash());
    render(initial.tab);
    if (initial.target) { reveal(initial.target); initial.target.scrollIntoView({ block: 'start' }); }
  });
})();
`;

function main() {
  const analytics = JSON.parse(readFileSync(analyticsResultsPath(), "utf8")) as Analytics;
  const selPath = selectionsPath();
  // §2 pre-populates each pending app's radio group from this file AND bakes the
  // whole object into the page as window.__priorSelections__ so the Download
  // button can merge prior picks with new ones. A missing file is normal; a
  // malformed file is logged and ignored so the HTML still renders.
  let selections: Selections = {};
  try {
    if (existsSync(selPath)) selections = JSON.parse(readFileSync(selPath, "utf8")) as Selections;
  } catch (e) {
    console.warn(`report: ignoring malformed ${selPath} (invalid JSON).`);
  }
  // Action URLs for resolved products, from enrichActions. Optional — the report
  // degrades gracefully if it's absent.
  const actions: Actions = existsSync(actionsPath()) ? JSON.parse(readFileSync(actionsPath(), "utf8")) : {};
  // Self-migrate actions.json entries written before marketplaceUrl.ts was
  // introduced; idempotent on clean entries.
  for (const l of Object.values(actions)) {
    l.procurementUrl = rewriteMarketplaceUrl(l.procurementUrl) || undefined;
    l.privateOfferUrl = rewriteMarketplaceUrl(l.privateOfferUrl) || undefined;
    l.demoUrl = rewriteMarketplaceUrl(l.demoUrl) || undefined;
    l.freeTrialUrl = rewriteMarketplaceUrl(l.freeTrialUrl) || undefined;
    l.listingUrl = rewriteMarketplaceUrl(l.listingUrl) || undefined;
  }
  const actFor = (a: AppRecord): ActionLinks | undefined => (a.resolved?.listingId ? actions[a.resolved.listingId] : undefined);
  // Canonical "View the Marketplace product" URL for a resolved listing: the fetched
  // listing URL if present, else the standard product-detail-page URL built from the
  // prodview id (always available for a confirmed app). Buyer-friendly, read-only link.
  const marketplaceUrlFor = (a: AppRecord): string | undefined =>
    rewriteMarketplaceUrl(
      actFor(a)?.listingUrl ?? (a.resolved?.listingId ? `https://aws.amazon.com/marketplace/pp/${a.resolved.listingId}` : undefined),
    );
  const mpTitleMd = (a: AppRecord): string => {
    const u = safeHttps(marketplaceUrlFor(a));
    return a.resolved?.title && u ? `[${cell(a.resolved.title)}](${u})` : cell(a.resolved?.title);
  };
  const mpTitleHtml = (a: AppRecord): string => {
    const u = safeHttps(marketplaceUrlFor(a));
    return a.resolved?.title && u ? `<a href="${attrEsc(u)}" target="_blank" rel="noopener">${esc(a.resolved.title)}</a>` : esc(a.resolved?.title);
  };
  // The buyer already owns these products, so buy / private-offer CTAs are
  // dropped from the buyer-facing output AND the JSON contract a UI builds on
  // (reserved for confirmed unmanaged-use apps; replaced by a renewal CTA for owned apps).
  // 2026-09-04: the "Demo" link is dropped too, for the same owned-product reason.
  const contractActFor = (a: AppRecord): Omit<ActionLinks, "procurementUrl" | "privateOfferUrl" | "demoUrl"> | undefined => {
    const l = actFor(a);
    if (!l) return undefined;
    const { procurementUrl: _p, privateOfferUrl: _o, demoUrl: _d, ...rest } = l;
    return Object.values(rest).some(Boolean) ? rest : undefined;
  };
  // Per-app "Renew on Marketplace" lead-capture mailto (prefilled with the
  // renewal facts; buyer completes contact fields, or uses the CLI form).
  const recipient = leadRecipient();
  const leadCtxFor = (a: AppRecord): LeadContext => ({
    app: a.app,
    vendor: a.vendor,
    product: a.resolved?.title ?? null,
    listingId: a.resolved?.listingId ?? null,
    listingUrl: actFor(a)?.listingUrl ?? null,
    annualSpend: a.spend,
    seats: a.seats,
    renewalDate: a.next_renewal ?? null,
    provider: analytics.generated_from,
    asOf: analytics.as_of,
  });
  const renewMailtoFor = (a: AppRecord): string => {
    const ctx = leadCtxFor(a);
    return buildMailto(recipient, renewSubject(ctx), renewBodyTemplate(ctx));
  };
  // "Get in touch" on the comparison widget: a NEW-PURCHASE mailto for a comparable
  // product the buyer does NOT own (spend/seats/renewal null; records against the
  // seed app it was compared to). Same lead workflow as renewal, kind:new_purchase.
  const purchaseCtxForPeer = (seedApp: string, p: CmpProduct): LeadContext => ({
    app: p.name, vendor: p.vendor ?? null, product: p.name,
    listingId: p.listingId ?? null, listingUrl: p.url ?? null,
    annualSpend: null, seats: null, renewalDate: null,
    comparedToApp: seedApp, provider: analytics.generated_from, asOf: analytics.as_of,
  });
  const purchaseMailtoForPeer = (seedApp: string, p: CmpProduct): string => {
    const ctx = purchaseCtxForPeer(seedApp, p);
    return buildMailto(recipient, purchaseSubject(ctx), purchaseBodyTemplate(ctx));
  };
  // Agreements tier (optional): apps the buyer ALREADY has a Marketplace agreement
  // for. Present only once Agreements is connected + enriched; report degrades
  // gracefully without it.
  const agreementsRaw: AgreementsFile | undefined = existsSync(agreementsPath())
    ? JSON.parse(readFileSync(agreementsPath(), "utf8"))
    : undefined;
  // A file recording a failed lookup (connected:false, or legacy realAgreementCount -1)
  // means Agreements is NOT connected — don't treat it as "zero agreements".
  const agreementsFailed = !!agreementsRaw && (agreementsRaw.connected === false || agreementsRaw.realAgreementCount === -1);
  const agreementsFile: AgreementsFile | undefined = agreementsFailed ? undefined : agreementsRaw;
  const agreementsReason = agreementsFailed
    ? agreementsRaw!.reason ?? "The Agreements API lookup failed (check AWS credentials and permissions)."
    : undefined;
  const byAppAgreement = agreementsFile?.byApp ?? {};
  const agreementFor = (a: AppRecord): Agreement | undefined => byAppAgreement[a.app];
  // Apps the buyer told us they already buy through AWS Marketplace (dashboard or chat;
  // record_already_on_marketplace). Without the Agreements API this is the only way we
  // know, and it works the same: the app leaves the opportunity sections.
  const marks: Record<string, { markedAt?: string }> = existsSync(alreadyOnMarketplacePath())
    ? JSON.parse(readFileSync(alreadyOnMarketplacePath(), "utf8"))
    : {};
  const markFor = (a: AppRecord) => (agreementFor(a) ? undefined : marks[a.app]);
  const onMp = (a: AppRecord) => !!agreementFor(a) || (!!marks[a.app] && a.status !== "not_on_marketplace");
  // Deployed-on-AWS (PPA/EDP drawdown eligibility) — optional; report degrades if absent.
  const deployment: Deployment = existsSync(deploymentPath()) ? JSON.parse(readFileSync(deploymentPath(), "utf8")) : {};
  const deployKnown = Object.keys(deployment).length > 0;
  // Comparable solutions per confirmed app (optional; report degrades if absent).
  const comparisons: Comparisons = existsSync(comparisonsPath()) ? JSON.parse(readFileSync(comparisonsPath(), "utf8")) : {};
  // Self-migrate comparisons.json entries written before marketplaceUrl.ts was
  // introduced; idempotent on clean entries.
  for (const c of Object.values(comparisons)) for (const p of c.products) p.url = rewriteMarketplaceUrl(p.url) || undefined;
  const cmpFor = (a: AppRecord): Comparison | undefined => {
    const c = comparisons[a.app];
    return c && c.products.length > 1 ? c : undefined;
  };
  const cmpKnown = Object.values(comparisons).some((c) => c.products.length > 1);
  const ppaFor = (a: AppRecord): DeployedOnAws => {
    const id = a.resolved?.listingId;
    return id ? deployment[id]?.deployedOnAws ?? "unknown" : "unknown";
  };
  // Used-but-uncontracted apps (adoption but no contract) — from match-results.json.
  // Optional: a source that can't detect them omits the field, and the callout is
  // simply absent (capability-gated, like every other tier here).
  const matchResults = existsSync(matchResultsPath()) ? JSON.parse(readFileSync(matchResultsPath(), "utf8")) : {};
  const noContractApps: NoContractAppRec[] = matchResults.noContractApps ?? [];
  const hasNoContract = noContractApps.length > 0;
  // Comparable-solutions section number shifts to 5 only when the no-contract
  // section (4) is present; otherwise it stays 4 (no gap).
  const cmpNum = hasNoContract ? 5 : 4;
  // Adoption differs by source (activity-based vs integration-status), so the
  // basis is footnoted rather than implied to be comparable.
  const adoptionBasis = noContractApps.find((a) => a.adoption?.activeBasis)?.adoption?.activeBasis;
  const basisNote =
    adoptionBasis === "activity"
      ? "Active = accounts with tracked activity in the source's window (90-day default)."
      : adoptionBasis === "status"
        ? "Active = accounts the source integration currently reports active (not usage recency)."
        : "";
  const adoptionMd = (ad?: AdoptionRec): string => {
    if (!ad) return "—";
    const p: string[] = [];
    if (ad.provisionedUsers != null) p.push(`${ad.provisionedUsers.toLocaleString()} accounts`);
    if (ad.activeUsers != null) p.push(`${ad.activeUsers.toLocaleString()} active`);
    return p.length ? p.join(" · ") : "—";
  };
  // unmanaged-use product suggestions for apps the buyer confirmed are used-without-
  // a-contract. Present only for those; a purchase CTA is valid only for this class.
  const shadowItSug: Record<string, ShadowItSug> = existsSync(shadowItSuggestionsPath())
    ? JSON.parse(readFileSync(shadowItSuggestionsPath(), "utf8"))
    : {};
  // Self-migrate shadow-it-suggestions.json entries written before marketplaceUrl.ts
  // was introduced; idempotent on clean entries.
  for (const s of Object.values(shadowItSug)) {
    s.procurementUrl = rewriteMarketplaceUrl(s.procurementUrl) || undefined;
    s.privateOfferUrl = rewriteMarketplaceUrl(s.privateOfferUrl) || undefined;
    s.listingUrl = rewriteMarketplaceUrl(s.listingUrl) || undefined;
  }
  const sugFor = (name: string): ShadowItSug | undefined => shadowItSug[name];
  // "What to do" cell for a no-contract row: buy CTAs once confirmed unmanaged use,
  // else the upload / review prompt.
  const noContractActMd = (name: string): string => {
    const s = sugFor(name);
    if (!s) return "Upload the contract, or review the app status";
    if (!s.found) return "Confirmed in use without a contract — no matching Marketplace product found";
    const b: string[] = [];
    if (s.procurementUrl) b.push(`[Buy on Marketplace](${s.procurementUrl})`);
    if (s.privateOfferUrl) b.push(`[Request a private offer](${s.privateOfferUrl})`);
    const label = `_suggested: ${cell(s.suggested?.title)}_`;
    return (b.length ? b.join(" · ") + " · " : "") + label;
  };
  // SaaS Manager app status (New / In review / Plan to close / Managed / Accepted / Closed / Ignored),
  // plus a flag once you've confirmed the app is genuinely in use without a contract.
  const appStatusLabel = (a: NoContractAppRec): string => {
    const raw = a.status ?? "";
    // "InReview" → "In review", "PlanToClose" → "Plan to close" (SaaS Manager's sentence case)
    const words = raw.replace(/([a-z])([A-Z])/g, "$1 $2");
    const pretty = raw ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : "No contract on record";
    return sugFor(a.name) ? `${pretty} · confirmed in use, no contract` : pretty;
  };
  const noContractActHtml = (name: string): string => {
    const s = sugFor(name);
    if (!s) return `<span class="howto">Upload the contract, or review the app status</span>`;
    if (!s.found) return `<span class="howto">Confirmed in use without a contract — no matching Marketplace product found</span>`;
    const b: string[] = [];
    if (safeHttps(s.procurementUrl)) b.push(`<a class="btn primary" href="${attrEsc(s.procurementUrl!)}" target="_blank" rel="noopener">Buy on Marketplace ↗</a>`);
    if (safeHttps(s.privateOfferUrl)) b.push(`<a class="btn secondary" href="${attrEsc(s.privateOfferUrl!)}" target="_blank" rel="noopener">Request a private offer ↗</a>`);
    return b.join(" ") + `<div class="howto">suggested: ${esc(s.suggested?.title)}</div>`;
  };

  const topN = Number(arg("--top") ?? 40);
  const candCap = Number(arg("--candidates") ?? 10);

  const apps = analytics.apps ?? [];
  // Apps already on Marketplace (per Agreements) are pulled OUT of the opportunity
  // sections so the buyer focuses only on contracts not yet moved to Marketplace.
  const alreadyOnMp = apps.filter((a) => onMp(a));
  const confirmed = apps.filter((a) => a.status === "confirmed" && !onMp(a));
  const pending = apps.filter((a) => a.status === "needs_selection" && !onMp(a));
  const notMp = apps.filter((a) => a.status === "not_on_marketplace");
  const confirmedBy = (a: AppRecord) => (selections[a.app] ? "buyer" : a.matchedBy === "line_item" ? "line_item" : "auto");
  const confirmedByLabel = (a: AppRecord) =>
    ({ buyer: "you", line_item: "line item", auto: "exact match" })[confirmedBy(a)];
  const sumSpend = (list: AppRecord[]) => list.reduce((s, a) => s + (a.spend ?? 0), 0);
  const alreadyUsd = sumSpend(alreadyOnMp);
  // PPA-eligible = focus-confirmed apps whose product is Deployed-on-AWS.
  const ppaEligible = confirmed.filter((a) => ppaFor(a) === "yes");
  const ppaEligibleUsd = sumSpend(ppaEligible);

  // ── Data checks: which catalog this run used, and whether the AWS Marketplace MCP's responses
  // had the expected shape (mcpShapes.ts). Shown on the dashboard and returned to the agent.
  const catalogChoice = readCatalogChoice();
  const mcpTotals = healthTotals(readMcpHealth(mcpHealthPath()));
  const checks: {
    catalog?: { source: string; label: string; reason: string };
    mcpShape: { ok: boolean; itemsChecked: number; itemsDropped: number; issues: { problem: string; count: number }[] };
    render?: { ok: boolean; problems: string[] };
  } = {
    catalog: catalogChoice ? { source: catalogChoice.mode, label: CATALOG_LABEL[catalogChoice.mode], reason: catalogChoice.reason } : undefined,
    mcpShape: { ok: mcpTotals.issues.length === 0, itemsChecked: mcpTotals.checked, itemsDropped: mcpTotals.dropped, issues: mcpTotals.issues.slice(0, 10) },
  };

  // ── JSON contract (for a UI or the agent) ──
  const contract: Record<string, any> = {
    generatedFrom: analytics.generated_from,
    asOf: analytics.as_of,
    checks,
    summary: {
      counts: analytics.counts,
      confirmedUsd: analytics.confirmed_usd,
      pendingUsd: analytics.pending_usd,
      notOnMarketplaceUsd: analytics.not_on_marketplace_usd,
      renewing90dConfirmedUsd: analytics.renewing_90d_confirmed_usd,
      // Agreements tier (present only when connected): what's already on Marketplace
      // and the resulting "focus" opportunity (matched spend not yet on Marketplace).
      agreements: agreementsFile
        ? {
            connected: true,
            assumed: agreementsFile.assumed ?? false,
            alreadyOnMarketplaceCount: alreadyOnMp.length,
            alreadyOnMarketplaceUsd: alreadyUsd,
            focusConfirmedUsd: sumSpend(confirmed),
            focusPendingUsd: sumSpend(pending),
          }
        : { connected: false, ...(agreementsReason ? { reason: agreementsReason } : {}) },
      // Everything known to be on Marketplace already (Agreements API + the buyer's own marks),
      // and the opportunity left once those are taken out.
      alreadyOnMarketplace: {
        count: alreadyOnMp.length,
        usd: alreadyUsd,
        markedByYou: alreadyOnMp.filter((a) => !agreementFor(a)).map((a) => a.app),
        readyToRenewCount: confirmed.length,
        readyToRenewUsd: sumSpend(confirmed),
        needsConfirmationCount: pending.length,
        needsConfirmationUsd: sumSpend(pending),
      },
      // PPA/EDP drawdown eligibility — only "Deployed on AWS" products count
      // (25% Marketplace cap, policy effective 2025-05-01).
      ppa: deployKnown
        ? {
            eligibleCount: ppaEligible.length,
            eligibleUsd: ppaEligibleUsd,
            notEligibleCount: confirmed.filter((a) => ppaFor(a) === "no").length,
            unknownCount: confirmed.filter((a) => ppaFor(a) === "unknown").length,
          }
        : undefined,
      // Used-but-uncontracted apps: no contract on record, so no spend figure.
      // Either the contract hasn't been uploaded, or it's unmanaged use (used, no agreement).
      noContract: hasNoContract ? { count: noContractApps.length } : undefined,
    },
    disclaimer: analytics.disclaimer,
    // Comparable Marketplace solutions per confirmed app (present when enriched).
    // Augment each non-seed comparable with a "Get in touch" new-purchase mailto for a UI.
    comparisons: cmpKnown
      ? Object.fromEntries(Object.entries(comparisons).map(([app, c]) => [app, {
          ...c,
          products: c.products.map((p) => (p.isSeed ? p : { ...p, getInTouchMailto: purchaseMailtoForPeer(app, p) })),
        }]))
      : undefined,
    // Apps used with no contract on record (adoption-only). Drives the upload /
    // unmanaged-use callout. Present only when the source can detect them.
    noContractApps: hasNoContract ? noContractApps : undefined,
    // For apps the buyer confirmed are unmanaged use, a suggested Marketplace
    // product + buy / private-offer URLs (a suggestion to confirm, not a match).
    shadowItSuggestions: Object.keys(shadowItSug).length ? shadowItSug : undefined,
    apps: apps.map((a) => ({
      app: a.app,
      vendor: a.vendor,
      seller: a.sellerName,
      status: a.status,
      confirmedBy: a.status === "confirmed" ? confirmedBy(a) : undefined,
      annualSpend: a.spend,
      seats: a.seats ?? undefined,
      renewal: { date: a.next_renewal ?? undefined, bucket: a.renewal_bucket, urgency: a.renewal_urgency },
      resolved: a.resolved
        ? {
            ...a.resolved,
            marketplaceUrl: marketplaceUrlFor(a),
            actions: contractActFor(a) ?? undefined,
            deployedOnAws: a.resolved.listingId ? deployment[a.resolved.listingId]?.deployedOnAws : undefined,
          }
        : undefined,
      alreadyOnMarketplace: onMp(a) || undefined,
      alreadyOnMarketplaceSource: onMp(a) ? (agreementFor(a) ? "agreements" : "you") : undefined,
      agreement: agreementFor(a) ?? undefined,
      selection: selections[a.app] ?? null,
      candidates: (a.candidates ?? []).map((c) => ({ listingId: c.listingId, title: c.title, categories: c.categories })),
      noneOption: { label: "None of these — not what I use / not on Marketplace", value: { none: true } },
      lineItemDescriptions: a.lineItemDescriptions?.length ? a.lineItemDescriptions : undefined,
      rationale: a.rationale,
    })),
  };
  writeFileSync(reportJsonPath(), JSON.stringify(contract, null, 2));

  // ── Markdown ──
  const L: string[] = [];
  const s = analytics;
  L.push(`# ${BRAND.report}\n\n_${BRAND.product}_`);
  L.push(`_Portfolio source: **${s.generated_from}** · figures as of **${s.as_of}**_\n`);
  // When Agreements is connected, confirmed/pending arrays already exclude apps
  // that are on Marketplace — so counts/sums reflect the FOCUS (not-yet-moved).
  const agr = agreementsFile;
  // "Focus" figures (the opportunity minus what's already on Marketplace) whenever we know of
  // any app already there: from the Agreements API, or marked by the buyer.
  const markedN = alreadyOnMp.filter((a) => !agreementFor(a)).length;
  const focusMode = !!agr || markedN > 0;
  const confN = focusMode ? confirmed.length : s.counts.confirmed;
  const confUsd = focusMode ? sumSpend(confirmed) : s.confirmed_usd;
  const pendN = focusMode ? pending.length : s.counts.needs_selection;
  const pendUsd = focusMode ? sumSpend(pending) : s.pending_usd;
  const renew90Usd = focusMode ? sumSpend(confirmed.filter((a) => a.renewal_bucket === "le_90d")) : s.renewing_90d_confirmed_usd;
  const focus = focusMode ? " _(not yet on Marketplace)_" : "";
  // How we know an app is already on Marketplace, for the section intro.
  const alreadyIntro = (html: boolean): string => {
    const em = (t: string) => (html ? `<em>${t}</em>` : `_${t}_`);
    const parts: string[] = [];
    if (agr) parts.push(`they have an active Marketplace agreement (via the Agreements API)${agr.assumed ? ` ${em("Prototype: assumed data.")}` : ""}`);
    if (markedN) parts.push(`you marked them as already bought through AWS Marketplace`);
    return `These apps are already consolidated: ${parts.join(", or ")}. They're left out of the sections below.`;
  };

  L.push(`## Summary\n`);
  if (focusMode) {
    L.push(`- **${BUCKETS.already.label}:** ${alreadyOnMp.length} applications · **${big(alreadyUsd)} ACV** — no action needed${agr?.assumed ? " _(prototype: assumed agreements)_" : ""}`);
  }
  L.push(`- **${BUCKETS.ready.label}:** ${confN} applications · **${big(confUsd)} ACV** — ${BUCKETS.ready.what}${focus}`);
  L.push(`- **${BUCKETS.confirm.label}:** ${pendN} applications · **${big(pendUsd)} ACV** — ${BUCKETS.confirm.what}`);
  L.push(`- **${BUCKETS.notmp.label}:** ${s.counts.not_on_marketplace} applications · **${big(s.not_on_marketplace_usd)} ACV** — ${BUCKETS.notmp.what}`);
  if (hasNoContract) L.push(`- **${BUCKETS.nocontract.label}:** ${noContractApps.length.toLocaleString()} applications — ${BUCKETS.nocontract.what}; upload the contract to see its value, or review its app status`);
  L.push(`- Confirmed ACV renewing in ≤90 days: **${big(renew90Usd)}**`);
  if (deployKnown) {
    L.push(`- **${BUCKETS.ppa.label}:** ${ppaEligible.length} of the ${confN} ready to renew · **${big(ppaEligibleUsd)} ACV** _(retires AWS commitment, up to the 25% Marketplace cap)_`);
  }
  if (agr) {
    L.push(`\n> ✓ **Agreements API connected.** ${alreadyOnMp.length} app(s) already have a Marketplace agreement and are excluded below so you can focus on what you haven't moved yet.${agr.assumed ? ` _${agr.note ?? "Prototype: assumed agreement data."}_` : ""}`);
  } else {
    if (agreementsReason) { const c = agreementsInvite(agreementsReason, markedN); L.push(`\n> **${c.title}** ${c.body}`); }
    L.push(`\n> ${s.disclaimer}`);
  }
  L.push("");

  // 0. Already on Marketplace (only when Agreements connected)
  if (focusMode && alreadyOnMp.length) {
    L.push(`## ${BUCKETS.already.label} — no action needed\n`);
    L.push(`${alreadyIntro(false)}\n`);
    L.push(`| Application | Your ACV | Committed on Marketplace | Term | Status |`);
    L.push(`|-----|--------------:|----------------:|------|--------|`);
    for (const a of [...alreadyOnMp].sort((x, y) => y.spend - x.spend)) {
      const g = agreementFor(a);
      const term = g?.startTime && g?.endTime ? `${g.startTime} → ${g.endTime}` : "—";
      L.push(`| ${cell(a.app)} | ${money(a.spend)} | ${g ? money(g.committedUsd ?? 0) : "—"} | ${term} | ${g ? g.status : "Marked by you"} |`);
    }
    L.push("");
  }

  // 1. Confirmed
  L.push(`## 1. ${BUCKETS.ready.label}\n`);
  L.push(`A specific Marketplace product is settled (you confirmed it, or it was the vendor's only / an exact match). "exact match" = pre-filled, still yours to change.\n`);
  L.push(`| Application | ACV | Renewal | Marketplace product | ${deployKnown ? "PPA | " : ""}Act | Confirmed by |`);
  L.push(`|-----|---------:|--------|---------------------|${deployKnown ? "-----|" : ""}-----|------------|`);
  for (const a of confirmed.slice(0, topN))
    L.push(`| ${cell(a.app)} | ${money(a.spend)} | ${URGENCY[a.renewal_urgency ?? "unknown"]} | ${mpTitleMd(a)} | ${deployKnown ? ppaMd(ppaFor(a)) + " | " : ""}${renewMd(renewMailtoFor(a), cmpFor(a) ? "cmp-" + slug(a.app) : undefined)} | ${confirmedByLabel(a)} |`);
  if (confirmed.length > topN) L.push(`\n_+ ${confirmed.length - topN} more confirmed (see report.json)._`);
  if (deployKnown) {
    L.push(`\n_**PPA column** (PPA = Private Pricing Agreement, EDP = Enterprise Discount Program) = eligibility to retire AWS commitment via Marketplace purchase. **✓ AWS** = product is 100% "Deployed on AWS" and counts toward PPA/EDP drawdown; **✗ non-AWS** = not eligible; **?** = deployment status unknown. Policy effective 2025-05-01; Marketplace cap is 25% of committed spend annually._`);
  }
  L.push("");

  // 2. Pending selection — the interactive core
  L.push(`## 2. ${BUCKETS.confirm.label}\n`);
  L.push(`For these, the **vendor sells on AWS Marketplace but your data doesn't say which product you use.** Pick the one you have — or "none of these" if it isn't a match.\n`);
  L.push(`> **To confirm:** just tell your consolidation agent which product you use for each app below — or that none of them match. It records your choice and updates this plan (confirmed picks move into section 1 with their spend). The listing ID next to each option is how the agent identifies the product; you don't need to type it.\n`);
  for (const a of pending.slice(0, topN)) {
    const cands = a.candidates ?? [];
    L.push(`### ${cell(a.app)} — ${money(a.spend)} ACV · ${cell(a.vendor)} · renewal ${URGENCY[a.renewal_urgency ?? "unknown"]}`);
    if (a.seats) L.push(`_${Math.round(a.seats).toLocaleString()} accounts · seller: ${cell(a.sellerName)}_`);
    for (let i = 0; i < Math.min(cands.length, candCap); i++)
      L.push(`- [${i + 1}] ${cell(cands[i].title)}  \`${cands[i].listingId}\``);
    if (cands.length > candCap) L.push(`- …+${cands.length - candCap} more (full list in report.json)`);
    L.push(`- [0] **None of these** — not what I use / not on Marketplace`);
    L.push("");
  }
  if (pending.length > topN) L.push(`_+ ${pending.length - topN} more pending apps (full candidate lists in report.json)._\n`);

  // 3. Not on Marketplace
  L.push(`## 3. ${BUCKETS.notmp.label}\n`);
  L.push(`**${notMp.length} applications · ${big(s.not_on_marketplace_usd)} ACV** — the vendor isn't sold on AWS Marketplace (or you marked "none"). Not consolidatable there.\n`);
  L.push(`| Application | ACV | Vendor |`);
  L.push(`|-----|---------:|--------|`);
  for (const a of [...notMp].sort((x, y) => y.spend - x.spend).slice(0, 15))
    L.push(`| ${cell(a.app)} | ${money(a.spend)} | ${cell(a.vendor)} |`);
  if (notMp.length > 15) L.push(`\n_+ ${notMp.length - 15} more (see report.json)._`);

  // 4. Apps without a contract on record — data-gap / unmanaged-use callout.
  if (hasNoContract) {
    L.push(`\n## 4. ${BUCKETS.nocontract.label}\n`);
    L.push(
      `These applications appear in your ${s.generated_from} portfolio, but we don't see a contract for them, so we can't calculate their consolidation value yet. That usually means one of two things: the contract hasn't been uploaded to ${s.generated_from}, or the app is being used without a formal agreement (sometimes called unmanaged use). Upload the contract to unlock complete insights, or review the app to decide how to manage it.\n`,
    );
    L.push(`| Application | Vendor | Category | Accounts | Status | What to do |`);
    L.push(`|-----|--------|----------|-------|--------|------------|`);
    const ncSorted = [...noContractApps].sort(
      (x, y) => (y.adoption?.provisionedUsers ?? 0) - (x.adoption?.provisionedUsers ?? 0),
    );
    for (const a of ncSorted.slice(0, topN))
      L.push(`| ${cell(a.name)} | ${cell(a.vendor)} | ${cell(a.descriptor)} | ${adoptionMd(a.adoption)} | ${appStatusLabel(a)} | ${noContractActMd(a.name)} |`);
    if (noContractApps.length > topN) L.push(`\n_+ ${noContractApps.length - topN} more (see report.json)._`);
    L.push(`\n_No spend figure is shown for these because spend comes from contracts.${basisNote ? " " + basisNote : ""}_`);
    L.push("");
  }

  // 5. Comparable solutions on AWS Marketplace — per confirmed app, a
  // side-by-side of a few Marketplace peers, from the Marketplace MCP catalog data.
  const cmpApps = confirmed.filter((a) => cmpFor(a));
  if (cmpKnown && cmpApps.length) {
    L.push(`\n## ${cmpNum}. Comparable solutions on AWS Marketplace\n`);
    L.push(`For each confirmed app, a few comparable Marketplace products to review before you renew — ranks, ratings, review sentiment, and whether a standard contract is offered. _Sentiment: ✅ positive · ⚠️ mixed · ❌ negative · – no data._\n`);
    const rows: [string, (p: CmpProduct) => string][] = [
      ["Vendor", (p) => cell(p.vendor)],
      ["Rating", (p) => ratingLabel(p)],
      ["Best rank", (p) => cell(rankLabel(p.bestRank))],
      ["Standard contract", (p) => (p.hasStandardContract == null ? "–" : p.hasStandardContract ? "Yes" : "No")],
      ["Functionality", (p) => sent(p.sentiments.functionality)],
      ["Ease of use", (p) => sent(p.sentiments.ease_of_use)],
      ["Customer service", (p) => sent(p.sentiments.customer_service)],
      ["Cost effectiveness", (p) => sent(p.sentiments.cost_effectiveness)],
    ];
    for (const a of cmpApps) {
      const c = cmpFor(a)!;
      const prods = c.products.slice(0, 5);
      L.push(`<a id="cmp-${slug(a.app)}"></a>`);
      L.push(`### ${cell(a.app)}`);
      const heads = prods.map((p) => `${safeHttps(p.url) ? `[${cell(p.name)}](${p.url})` : cell(p.name)}${p.isSeed ? " ★" : ""}`);
      L.push(`| | ${heads.join(" | ")} |`);
      L.push(`|---|${prods.map(() => "---").join("|")}|`);
      for (const [label, fn] of rows) L.push(`| **${label}** | ${prods.map((p) => fn(p)).join(" | ")} |`);
      // "Get in touch" to discuss buying a comparable product (new purchase, not renewal).
      L.push(`| **Get in touch** | ${prods.map((p) => (p.isSeed ? "you own this" : `[Get in touch](${purchaseMailtoForPeer(a.app, p)})`)).join(" | ")} |`);
      L.push(`\n_★ = your current product. Candidates via ${c.candidateSource === "related" ? "Marketplace related-solutions" : "category search"}. "Get in touch" logs a new-purchase lead to the AWS advisor team._\n`);
    }
  }

  const mdPath = reportMdPath();
  writeFileSync(mdPath, L.join("\n") + "\n");

  // ── HTML (styled, standalone — same content as the Markdown) ──
  const H: string[] = [];
  H.push(`<!doctype html><html lang="en"><head><meta charset="utf-8">`);
  H.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  // The dashboard is one self-contained file: it loads nothing and sends nothing. The CSP makes that
  // a rule, so even injected markup couldn't fetch, post or load a script from anywhere.
  H.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`);
  H.push(`<title>${esc(BRAND.report)} · ${esc(BRAND.product)}</title>`);
  H.push(`<style>${THEME_TOKENS}\n${CSS}</style></head><body><main>`);
  // Header: a co-brand bar — 1Password SaaS Manager on the left, the AWS Marketplace logo in the
  // top-right corner — then the title and subtitle at full width.
  H.push(`<header class="report-head">`);
  H.push(`<div class="brand">${brandLogo()}<span>${esc(BRAND.product)}</span>${AWS_MARKETPLACE_LOGO ? `<img class="partner-logo" src="${AWS_MARKETPLACE_LOGO}" alt="AWS Marketplace" width="116" height="28">` : ""}</div>`);
  H.push(`<h1>${esc(BRAND.report)}</h1>`);
  H.push(`<p class="sub">Which of your SaaS applications you can consolidate onto AWS Marketplace · from ${esc(s.generated_from)}, figures as of ${esc(s.as_of)}</p>`);
  if (checks.catalog) {
    H.push(`<p class="catalog-note">Matched using ${esc(checks.catalog.label)}.${checks.catalog.source === "mcp" ? " For the most complete matching, connect a read-only AWS profile from your own AWS account (ask your agent)." : ""}</p>`);
  }
  H.push(`</header>`);
  // The data notice (if any) goes here; it's filled in after the page is built and checked.
  const noticeAt = H.length;
  // Tabs (Tabs). Every section is a tab panel; the stat strip and the Overview's Actions
  // link to them. Without JS all panels stay visible, so the report still reads top to bottom.
  const renewSoon = confirmed.filter((a) => a.renewal_bucket === "le_90d");
  const tabs: { id: string; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "renew", label: BUCKETS.ready.tab, count: confN },
    { id: "confirm", label: BUCKETS.confirm.tab, count: pendN },
    { id: "not-on-marketplace", label: BUCKETS.notmp.tab, count: notMp.length },
    ...(hasNoContract ? [{ id: "no-contract", label: BUCKETS.nocontract.tab, count: noContractApps.length }] : []),
    { id: "already", label: BUCKETS.already.tab, count: alreadyOnMp.length },
  ];
  const openPanel = (id: string) =>
    H.push(`<section class="tab-panel" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}" tabindex="0">`);
  const closePanel = () => H.push(`</section>`);

  // How the buckets relate: the first three split the contracted portfolio (they add up).
  const portfolioN = (focusMode ? alreadyOnMp.length : 0) + confN + pendN + s.counts.not_on_marketplace;
  const portfolioUsd = (focusMode ? alreadyUsd : 0) + confUsd + pendUsd + s.not_on_marketplace_usd;
  H.push(`<p class="portfolio-line">Your <strong>${big(portfolioUsd)} ACV</strong> across <strong>${portfolioN.toLocaleString()} applications with a contract</strong>, by where each stands on AWS Marketplace${hasNoContract ? ` — plus <strong>${noContractApps.length.toLocaleString()}</strong> in use without one` : ""}:</p>`);
  const cardsAt = H.length;
  H.push(`<section class="cards" aria-label="Summary">`);
  H.push(card(BUCKETS.already.label, alreadyOnMp.length, alreadyUsd, "done", "already", BUCKETS.already.what, "already"));
  // The lead tile: the action this report exists for. Highlighted, with the near-term renewals; the
  // whole tile opens the Ready to renew tab (where each application has its Renew button).
  H.push(`<a href="#renew" data-tab="renew" class="card ok ready"><div class="k">${BUCKETS.ready.label}</div><div class="v" data-stat="ready-usd">${big(confUsd)}</div>`
    + `<div class="c"><span data-stat="ready-n">${confN.toLocaleString()}</span> applications · ${BUCKETS.ready.what}</div>`
    + `<div class="ready-soon" data-stat-show="soon-n"${renewSoon.length ? "" : " hidden"}><span data-stat="soon-n">${renewSoon.length}</span> renew in the next 90 days · <span data-stat="soon-usd">${big(renew90Usd)}</span></div>`
    + `</a>`);
  H.push(card(BUCKETS.confirm.label, pendN, pendUsd, "warn", "confirm", BUCKETS.confirm.what, "confirm"));
  H.push(card(BUCKETS.notmp.label, s.counts.not_on_marketplace, s.not_on_marketplace_usd, "muted", "not-on-marketplace", BUCKETS.notmp.what));
  if (hasNoContract)
    H.push(
      `<a href="#no-contract" data-tab="no-contract" class="card muted"><div class="k">${BUCKETS.nocontract.label}</div><div class="v">${noContractApps.length.toLocaleString()}</div><div class="c">applications · ${BUCKETS.nocontract.what}</div></a>`,
    );
  if (deployKnown)
    H.push(`<a href="#renew" data-tab="renew" class="card ppa"><div class="k">${BUCKETS.ppa.label}</div><div class="v" data-stat="ppa-usd">${big(ppaEligibleUsd)}</div><div class="c"><span data-stat="ppa-n">${ppaEligible.length}</span> of the <span data-stat="ready-n">${confN}</span> ready to renew run on AWS (PPA/EDP)</div></a>`);
  // One row for up to 5 tiles; beyond that, two even rows (6 → 3 × 2).
  const nCards = H.length - cardsAt - 1;
  H[cardsAt] = `<section class="cards" aria-label="Summary" style="--cols:${nCards <= 5 ? nCards : Math.ceil(nCards / 2)}">`;
  H.push(`</section>`);

  H.push(`<div class="tabs-bar"><div class="tabs" role="tablist" aria-label="Report sections">`
    + tabs.map((t, i) => `<a class="tab" role="tab" id="tab-${t.id}" href="#${t.id}" data-tab="${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><span>${esc(t.label)}</span>${t.count != null ? `<span class="pill" data-stat="tab-${t.id}">${t.count.toLocaleString()}</span>` : ""}</a>`).join("")
    + `</div><button type="button" class="btn tertiary" data-show-all aria-pressed="false" title="Show every section on one page">Show all</button></div>`);

  openPanel("overview");
  // Actions — what needs the buyer's attention, SaaS Manager-style; each row opens its tab.
  const actionRow = (tab: string, title: string, sub: string, n: number, stat?: string) =>
    `<a class="action-row" href="#${tab}" data-tab="${tab}"><span><span class="action-title">${title}</span><span class="action-sub">${sub}</span></span><span class="action-n"${stat ? ` data-stat="${stat}"` : ""}>${n.toLocaleString()}</span></a>`;
  H.push(`<section class="actions" aria-labelledby="actions-h"><h3 id="actions-h">Actions</h3><p class="action-intro">What needs your attention in this report</p>`
    + actionRow("renew", "Renew in the next 90 days", `${BUCKETS.ready.label} · <span data-stat="soon-usd">${big(renew90Usd)}</span> ACV`, renewSoon.length, "soon-n")
    + actionRow("confirm", "Confirm which product you use", `${BUCKETS.confirm.label} · <span data-stat="confirm-usd">${big(pendUsd)}</span> ACV`, pendN, "confirm-n")
    + (hasNoContract ? actionRow("no-contract", "Upload or review contracts", `${BUCKETS.nocontract.label} · in use, no ACV yet`, noContractApps.length) : "")
    + `</section>`);
  if (agr) {
    H.push(calloutHtml("informational", `<strong>Agreements API connected.</strong> ${alreadyOnMp.length} app(s) already have a Marketplace agreement and are excluded from the sections below, so you can focus on contracts you haven't moved yet.${agr.assumed ? ` <em>${esc(agr.note ?? "Prototype: assumed agreement data.")}</em>` : ""}`));
  } else {
    if (agreementsReason) { const c = agreementsInvite(agreementsReason, markedN); H.push(calloutHtml("informational", `<strong>${esc(c.title)}</strong> ${esc(c.body)}`)); }
    H.push(calloutHtml("informational", markedN
      ? `<strong>${markedN} application${markedN === 1 ? "" : "s"} you marked as already on AWS Marketplace</strong> ${markedN === 1 ? "is" : "are"} left out of the opportunity sections (${big(sumSpend(alreadyOnMp.filter((a) => !agreementFor(a))))} ACV). See <a href="#already" data-tab="already">${BUCKETS.already.label}</a>.`
      : `<strong>Already buying some of these through AWS Marketplace?</strong> This report can't see your AWS Marketplace purchases. Use <em>Already on Marketplace</em> on an application's row, or tell your agent: it moves to the <a href="#already" data-tab="already">${BUCKETS.already.tab}</a> tab and the totals update.`));
  }
  // The fine print, out of the way until wanted.
  H.push(`<details class="disclosure about"><summary><span class="disc-icon" aria-hidden="true"></span><span class="disc-title">About these numbers</span></summary><div class="about-body">`
    + `<p>${esc(s.disclaimer)}</p>`
    + (deployKnown ? `<p><strong>Deployed on AWS (PPA/EDP eligible):</strong> products that run 100% on AWS count toward drawing down an AWS commitment (PPA = Private Pricing Agreement, EDP = Enterprise Discount Program) when bought through AWS Marketplace — up to 25% of annual committed spend (policy effective 2025-05-01).</p>` : "")
    + `<p>Figures are as of ${esc(s.as_of)}, from ${esc(s.generated_from)}. Regenerate the report to refresh them.</p>`
    + `</div></details>`);
  closePanel();

  // The bar that applies on-page changes (product picks, Already on Marketplace marks) through the
  // agent. Sticky on the Needs confirmation tab; on Ready to renew it appears once there's a change.
  const providerId = activeSaaSProvider().id;
  const actionBar = (sticky: boolean, autoHide = false): string =>
    `<div class="sel-bar${sticky ? " sticky" : ""}" data-action-bar${autoHide ? " data-autohide hidden" : ""}>` +
    `<div class="sel-bar-text" data-sel-text>Pick a product for each application. Picks aren't applied until you give them to your agent.</div>` +
    `<div class="sel-bar-actions">` +
    `<button type="button" class="btn primary" data-action="copy">Copy for your agent</button>` +
    (autoHide ? "" : `<button type="button" class="btn secondary" data-action="download">Download selections.json</button>`) +
    `<span class="sel-status" data-status aria-live="polite"></span>` +
    `</div></div>`;
  // A row that "Already on Marketplace" can move: its bucket, ACV, and whether it counts toward the
  // 90-day and PPA totals, so the page can recalculate without a regenerate.
  const moveAttrs = (a: AppRecord, bucket: "ready" | "confirm") =>
    ` data-move="${bucket}" data-acv="${Math.round(a.spend)}"`
    + (bucket === "ready" && a.renewal_bucket === "le_90d" ? ` data-soon` : "")
    + (bucket === "ready" && deployKnown && ppaFor(a) === "yes" ? ` data-ppa` : "");
  // The totals as generated; the page adds and subtracts the rows moved on it.
  H.push(`<script>window.__totals__ = ${JSON.stringify({
    already: { n: alreadyOnMp.length, usd: Math.round(alreadyUsd) },
    ready: { n: confN, usd: Math.round(confUsd) },
    soon: { n: renewSoon.length, usd: Math.round(renew90Usd) },
    ppa: { n: ppaEligible.length, usd: Math.round(ppaEligibleUsd) },
    confirm: { n: pendN, usd: Math.round(pendUsd) },
  })};</script>`);
  openPanel("renew");
  H.push(actionBar(true, true));
  H.push(`<div class="renew-print">`);
  H.push(`<div class="section-head"><h2>${BUCKETS.ready.label}</h2>`
    + `<button type="button" class="btn secondary no-print" data-print-renew title="Print this list, or save it as a PDF from the print dialog">Print to PDF</button></div>`);
  // Print-only summary line, so the PDF stands on its own.
  H.push(`<p class="print-only"><strong><span data-stat="ready-n">${confN.toLocaleString()}</span> applications · <span data-stat="ready-usd">${big(confUsd)}</span> ACV</strong><span data-stat-show="soon-n"${renewSoon.length ? "" : " hidden"}> · <span data-stat="soon-n">${renewSoon.length}</span> renew in the next 90 days (<span data-stat="soon-usd">${big(sumSpend(renewSoon))}</span>)</span></p>`);
  H.push(`<p>Each of these is <strong>matched to a specific AWS Marketplace product</strong> — you confirmed it, or it was the vendor's only listing or an exact match (still yours to change). Renew them through AWS Marketplace; the soonest renewals come first.</p>`);
  // Shown by SCRIPT once the buyer has picked an email app for lead buttons.
  H.push(`<p id="mail-pref" class="mail-pref" hidden>Renewal and inquiry emails open in <span data-mail-name></span>. <a href="#" data-mail-reset>Change</a></p>`);
  // Comparison of one confirmed app vs comparable Marketplace products — shown inline under its row.
  const cmpRows: [string, (p: CmpProduct) => string][] = [
    ["Vendor", (p) => esc(p.vendor)],
    ["Rating", (p) => ratingLabel(p)],
    ["Best rank", (p) => esc(rankLabel(p.bestRank))],
    ["Standard contract", (p) => (p.hasStandardContract == null ? "–" : p.hasStandardContract ? "Yes" : "No")],
    ["Functionality", (p) => sent(p.sentiments.functionality)],
    ["Ease of use", (p) => sent(p.sentiments.ease_of_use)],
    ["Customer service", (p) => sent(p.sentiments.customer_service)],
    ["Cost effectiveness", (p) => sent(p.sentiments.cost_effectiveness)],
  ];
  const cmpTableHtml = (a: AppRecord): string => {
    const c = cmpFor(a)!;
    const prods = c.products.slice(0, 5);
    const heads = prods
      .map((p) => `<th>${safeHttps(p.url) ? `<a href="${attrEsc(p.url!)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}${p.isSeed ? ` <span class="seedstar" title="your current product">★</span>` : ""}</th>`)
      .join("");
    const body = cmpRows.map(([label, fn]) => `<tr><td class="cmp-lbl">${label}</td>${prods.map((p) => `<td>${fn(p)}</td>`).join("")}</tr>`).join("")
      // "Get in touch" to discuss buying a comparable product (new purchase, not renewal).
      + `<tr><td class="cmp-lbl">Get in touch</td>${prods.map((p) => `<td>${p.isSeed ? `<span class="muted">you own this</span>` : leadMailHtml(purchaseMailtoForPeer(a.app, p), "Get in touch ↗", "secondary")}</td>`).join("")}</tr>`;
    return `<p class="cmp-title">Comparable solutions for <strong>${esc(a.app)}</strong></p>`
      + `<table class="cmp-t"><thead><tr><th></th>${heads}</tr></thead><tbody>${body}</tbody></table>`
      + `<p class="howto">★ = your current product · Sentiment: ✅ positive · ⚠️ mixed · ❌ negative · – no data · candidates via ${c.candidateSource === "related" ? "Marketplace related-solutions" : "category search"} · "Get in touch" logs a new-purchase lead to the AWS advisor team.</p>`;
  };
  const fmtDate = (iso?: string | null) =>
    iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
  // Renewal groups = Disclosure: what renews soon is open; later / past / undated start closed.
  const CONFIRMED_BY_HINT: Record<string, string> = {
    buyer: "You picked this product", line_item: "Matched from a contract line item", auto: "The vendor's only listing, or an exact name match",
  };
  const RENEW_GROUPS = [
    { key: "act_now", label: "Renews in the next 90 days", open: true },
    { key: "plan", label: "Renews within a year", open: true },
    { key: "monitor", label: "Renews later", open: false },
    { key: "expired", label: "Renewal date has passed", open: false },
    { key: "unknown", label: "No renewal date", open: false },
  ];
  const renewCols = deployKnown ? 7 : 6;
  for (const g of RENEW_GROUPS) {
    const rows = confirmed.filter((a) => (a.renewal_urgency ?? "unknown") === g.key).sort((x, y) => y.spend - x.spend);
    if (!rows.length) continue;
    H.push(`<details class="disclosure" data-renew-group${g.open ? " open" : ""}><summary><span class="disc-icon" aria-hidden="true"></span><span class="disc-title">${g.label}</span>`
      + `<span class="pill" data-group-n>${rows.length}</span><span class="disc-meta"><span data-group-usd>${big(sumSpend(rows))}</span> ACV</span></summary>`);
    H.push(`<table class="renew-t${deployKnown ? " has-ppa" : ""}"><thead><tr><th>Application</th><th class="r">ACV</th><th>Renewal</th><th>Marketplace product</th>${deployKnown ? `<th title="Deployed on AWS = counts toward PPA/EDP commitment drawdown">PPA</th>` : ""}<th class="acts">Act</th><th>Confirmed by</th></tr></thead><tbody>`);
    for (const a of rows) {
      const cmpId = cmpFor(a) ? "cmp-" + slug(a.app) : undefined;
      H.push(`<tr${moveAttrs(a, "ready")}><td><div class="cell-main truncate" title="${attrEsc(a.app)}">${esc(a.app)}</div><div class="cell-sub truncate" title="${attrEsc(a.vendor ?? "")}">${esc(a.vendor)}</div></td>`
        + `<td class="r">${money(a.spend)}</td><td>${fmtDate(a.next_renewal)}</td>`
        + `<td><div class="truncate" title="${attrEsc(a.resolved?.title ?? "")}">${mpTitleHtml(a)}</div></td>`
        + `${deployKnown ? `<td>${ppaHtml(ppaFor(a))}</td>` : ""}<td class="acts">${renewHtml(renewMailtoFor(a), cmpId)} ${markToggle(a.app, false)}</td>`
        + `<td><span class="pill" title="${attrEsc(CONFIRMED_BY_HINT[confirmedBy(a)])}">${confirmedByLabel(a)}</span></td></tr>`);
      if (cmpId) H.push(`<tr class="cmp-row" id="${cmpId}" hidden><td colspan="${renewCols}">${cmpTableHtml(a)}</td></tr>`);
    }
    H.push(`</tbody></table></details>`);
  }
  if (deployKnown) {
    H.push(`<p class="disclaimer">"Compare" shows a few comparable Marketplace products per application, from the AWS Marketplace catalog. Each product name links to its Marketplace page for full details.</p>`);
    H.push(`<p class="disclaimer"><strong>PPA column</strong> (PPA = Private Pricing Agreement, EDP = Enterprise Discount Program) = eligibility to retire AWS commitment via Marketplace purchase. <span class="pill success">✓ AWS</span> = product is 100% "Deployed on AWS" and counts toward PPA/EDP drawdown; <span class="pill critical">✗ non-AWS</span> = not eligible; <span class="pill">?</span> = deployment status unknown. Policy effective 2025-05-01; Marketplace cap is 25% of annual committed spend.</p>`);
  }
  H.push(`</div>`);

  closePanel();

  openPanel("confirm");
  H.push(`<h2>${BUCKETS.confirm.label}</h2>`);
  H.push(`<p>For these, the <strong>vendor sells on AWS Marketplace, but your data doesn't say which product you use.</strong> Pick the one you have — or "None of these" — and they move to <em>${BUCKETS.ready.label}</em> (or <em>${BUCKETS.notmp.label}</em>) when you regenerate.</p>`);
  // Interactive §2: radio-per-candidate + "None of these", a sticky action bar
  // for Download/Copy, pre-population from any existing out/<provider>/selections.json,
  // and the exact self-service instructions for applying the exported file.
  // Bake the prior selections into the page so the Download button can merge
  // them with new picks — stale apps that have moved out of §2 pass through.
  // The </ escape prevents an inline `<` in an app name from closing the tag.
  H.push(`<script>window.__priorSelections__ = ${JSON.stringify(forAgent(selections)).replace(/</g, "\\u003c")};</script>`);

  H.push(`<p class="sel-howto">Choose the Marketplace product that matches each application below. <strong>Your picks are saved only on this page until you apply them:</strong> click <em>Copy for your agent</em>, paste into your agent's chat, and it records them and regenerates this report, moving each application into <em>${BUCKETS.ready.label}</em> (or <em>${BUCKETS.notmp.label}</em> for "None of these"). Or download <code>selections.json</code>, save it as <code>out/${esc(providerId)}/selections.json</code>, and run <code>npm run analyze &amp;&amp; npm run report</code>.</p>`);
  H.push(actionBar(true));
  // One Table row per Application; the product choice is a Select (all candidates +
  // "None of these"). Line items from the contract are shown as the hint. The selected listing's
  // Marketplace page is one click away ("View listing", updated by SCRIPT).
  const contractHint = (a: AppRecord): string => {
    const d = (a.lineItemDescriptions ?? []).filter(Boolean);
    if (!d.length) return `<span class="cell-sub">—</span>`;
    return `<span class="contract-hint truncate" title="${attrEsc(d.join("\n"))}">“${esc(d[0])}”</span>${d.length > 1 ? `<span class="cell-sub">+${d.length - 1} more line item${d.length > 2 ? "s" : ""}</span>` : ""}`;
  };
  H.push(`<table class="confirm-t"><thead><tr><th>Application</th><th class="r">ACV</th><th>Renewal</th><th>From your contract</th><th>Your Marketplace product</th></tr></thead><tbody>`);
  for (const a of pending.slice(0, topN)) {
    const cands = a.candidates ?? [];
    const prior = selections[a.app];
    const priorListingId = prior?.listingId;
    const priorNone = prior?.none === true;
    const priorMissingFromCandidates = !!priorListingId && !cands.some((c) => c.listingId === priorListingId);
    const listingUrl = (id: string) => rewriteMarketplaceUrl(`https://aws.amazon.com/marketplace/pp/${id}`) ?? "";
    const sub = [esc(a.vendor), a.seats ? `${Math.round(a.seats).toLocaleString()} accounts` : "", a.sellerName && a.sellerName !== a.vendor ? `seller: ${esc(a.sellerName)}` : ""].filter(Boolean).join(" · ");
    const options = [
      `<option value="" disabled${!priorListingId && !priorNone ? " selected" : ""}>Choose a product…</option>`,
      ...cands.map((c) => `<option value="${attrEsc(c.listingId)}" data-url="${attrEsc(listingUrl(c.listingId))}"${priorListingId === c.listingId ? " selected" : ""}>${esc(c.title)}</option>`),
      `<option value="__NONE__"${priorNone ? " selected" : ""}>None of these — not what I use / not on Marketplace</option>`,
    ].join("");
    const chosen = priorListingId && !priorMissingFromCandidates ? listingUrl(priorListingId) : "";
    H.push(`<tr${moveAttrs(a, "confirm")}><td><div class="cell-main truncate" title="${attrEsc(a.app)}">${esc(a.app)}</div><div class="cell-sub truncate" title="${attrEsc(sub.replace(/<[^>]+>/g, ""))}">${sub}</div></td>`
      + `<td class="r">${money(a.spend)}</td><td>${URGENCY[a.renewal_urgency ?? "unknown"]}</td><td>${contractHint(a)}</td>`
      + `<td class="choose-cell"><span class="select-wrap"><select class="theme-select" required data-app-name="${attrEsc(a.app)}" aria-label="Marketplace product for ${attrEsc(a.app)}">${options}</select></span>`
      + `<a class="view-listing" href="${attrEsc(chosen)}" target="_blank" rel="noopener"${chosen ? "" : " hidden"}>View listing ↗</a>`
      + markToggle(a.app, false)
      + (priorMissingFromCandidates ? `<p class="stale">Previously selected: <code>${esc(priorListingId!)}</code> (no longer offered)</p>` : "")
      + `</td></tr>`);
  }
  H.push(`</tbody></table>`);
  if (pending.length > topN) H.push(`<p class="more">+ ${pending.length - topN} more pending apps (full candidate lists in report.json).</p>`);
  H.push(actionBar(false));
  H.push(`<pre id="sel-dump" class="sel-dump" hidden></pre>`);
  closePanel();

  openPanel("not-on-marketplace");
  H.push(`<h2>${BUCKETS.notmp.label}</h2>`);
  H.push(`<p><strong>${notMp.length} applications · ${big(s.not_on_marketplace_usd)} ACV</strong> — the vendor doesn't sell on AWS Marketplace today (or you marked "None of these"), so these can't be consolidated there yet.</p>`);
  H.push(`<table class="notmp-t"><thead><tr><th>Application</th><th class="r">ACV</th></tr></thead><tbody>`);
  for (const a of [...notMp].sort((x, y) => y.spend - x.spend).slice(0, 15))
    H.push(`<tr><td><div class="cell-main truncate">${esc(a.app)}</div><div class="cell-sub truncate">${esc(a.vendor)}</div></td><td class="r">${money(a.spend)}</td></tr>`);
  H.push(`</tbody></table>`);
  if (notMp.length > 15) H.push(`<p class="more">+ ${notMp.length - 15} more (see report.json).</p>`);
  closePanel();

  // 4 · Apps without a contract on record (data-gap / unmanaged-use callout)
  if (hasNoContract) {
    openPanel("no-contract");
    H.push(`<h2>${BUCKETS.nocontract.label}</h2>`);
    H.push(
      `<p>These applications appear in your <strong>${esc(s.generated_from)}</strong> portfolio, but we don't see a contract for them, so we can't calculate their consolidation value yet. That usually means one of two things: the contract hasn't been uploaded to ${esc(s.generated_from)}, or the app is being used without a formal agreement (sometimes called unmanaged use). Upload the contract to unlock complete insights, or review the app to decide how to manage it.</p>`,
    );
    H.push(`<table class="nc-t"><thead><tr><th>Application</th><th>Accounts</th><th>Status</th><th>What to do</th></tr></thead><tbody>`);
    const ncSortedH = [...noContractApps].sort(
      (x, y) => (y.adoption?.provisionedUsers ?? 0) - (x.adoption?.provisionedUsers ?? 0),
    );
    const NC_FIRST = 10;
    const ncShown = ncSortedH.slice(0, topN);
    ncShown.forEach((a, i) => {
      const sub = [a.vendor, a.descriptor].filter(Boolean).map((x) => esc(x)).join(" · ");
      H.push(
        `<tr${i >= NC_FIRST ? ` class="more-row" hidden` : ""}><td><div class="cell-main truncate" title="${attrEsc(a.name)}">${esc(a.name)}</div><div class="cell-sub truncate">${sub}</div></td><td>${esc(adoptionMd(a.adoption))}</td>` +
          `<td><span class="pill">${esc(appStatusLabel(a))}</span></td><td class="acts">${noContractActHtml(a.name)}</td></tr>`,
      );
    });
    H.push(`</tbody></table>`);
    if (ncShown.length > NC_FIRST) H.push(`<button type="button" class="btn secondary" data-show-more>Show ${ncShown.length - NC_FIRST} more</button>`);
    if (noContractApps.length > topN) H.push(`<p class="more">+ ${noContractApps.length - topN} more (see report.json).</p>`);
    H.push(`<p class="disclaimer">No spend figure is shown for these because spend comes from contracts.${basisNote ? " " + esc(basisNote) : ""}</p>`);
    closePanel();
  }

  // Already on AWS Marketplace: its own tab. Applications bought through Marketplace (Agreements API,
  // or marked by you) are left out of every other section. Marking a row elsewhere moves it here on
  // the page straight away and updates the totals; your agent applies the mark (Copy for your agent).
  openPanel("already");
  H.push(actionBar(false, true));
  H.push(`<h2>${BUCKETS.already.label} <span class="hint">— no action needed</span></h2>`);
  H.push(`<p>These applications are already consolidated: ${agr ? `they have an active Marketplace agreement (via the Agreements API)${agr.assumed ? ` <em>Prototype: assumed data.</em>` : ""}, or ` : ""}you marked them as already bought through AWS Marketplace. They're left out of the other sections and their totals.</p>`);
  H.push(`<p class="already-empty"${alreadyOnMp.length ? " hidden" : ""}>Nothing here yet. Use <em>Already on Marketplace</em> on an application in <a href="#renew" data-tab="renew">${BUCKETS.ready.tab}</a> or <a href="#confirm" data-tab="confirm">${BUCKETS.confirm.tab}</a> and it moves here.</p>`);
  H.push(`<table class="already-t"${alreadyOnMp.length ? "" : " hidden"}><thead><tr><th>Application</th><th class="r">Your ACV</th><th class="r">Committed on Marketplace</th><th>Term</th><th>Status</th></tr></thead><tbody>`);
  for (const a of [...alreadyOnMp].sort((x, y) => y.spend - x.spend)) {
    const g = agreementFor(a);
    const term = g?.startTime && g?.endTime ? `${g.startTime} → ${g.endTime}` : "—";
    const status = g
      ? `<span class="pill informational">${esc(g.status)}</span>`
      : `<span class="pill">Marked by you</span> ${markToggle(a.app, true)}`;
    H.push(`<tr class="done-row" data-acv="${Math.round(a.spend)}"><td>${esc(a.app)}</td><td class="r">${money(a.spend)}</td><td class="r">${g ? money(g.committedUsd ?? 0) : "—"}</td><td>${esc(term)}</td><td>${status}</td></tr>`);
  }
  H.push(`</tbody></table>`);
  closePanel();

  // One shared email-app chooser for every lead button (positioned by SCRIPT).
  H.push(`<div id="mail-chooser" class="mail-chooser" role="menu" aria-label="Choose your email app" tabindex="-1" hidden>`
    + `<p class="mc-title">Open this email in…</p>`
    + mcOpt("gmail", "Gmail", "Any Google or Google Workspace mailbox, including one you read in desktop Outlook")
    + mcOpt("outlook", "Outlook on the web", "Microsoft 365 work or school account")
    + mcOpt("outlookcom", "Outlook.com", "Personal Microsoft account")
    + mcOpt("default", "Desktop email app", "The app set to open email links, e.g. Outlook or Mail")
    + `<div class="mc-divider" role="separator"></div>`
    + mcOpt("copy", "Copy the email instead", "Paste it into any email app")
    + `<label class="mc-remember"><input type="checkbox" checked> Remember my choice</label></div>`);
  H.push(`<div id="mail-toast" class="mail-toast" role="status" aria-live="polite" hidden><span data-toast-text></span>`
    + `<button type="button" class="btn secondary" data-mail-change>Use another email app</button>`
    + `<button type="button" class="btn tertiary" data-toast-close aria-label="Dismiss">Dismiss</button></div>`);
  H.push(`</main><script>${SCRIPT}</script></body></html>`);

  // ── Render check: does the finished page look right? Then add a notice for anything wrong.
  checks.render = { ok: true, problems: renderProblems(H.join("\n"), tabs.map((t) => t.id)) };
  checks.render.ok = checks.render.problems.length === 0;
  const notice = dataNotice(checks);
  if (notice) H.splice(noticeAt, 0, notice);
  for (const p of checks.render.problems) console.error(`  ⚠ render check: ${p}`);
  for (const i of checks.mcpShape.issues) console.error(`  ⚠ AWS Marketplace MCP response changed: ${i.problem} (×${i.count})`);
  // report.json carries the checks too, so the agent hears about them.
  writeFileSync(reportJsonPath(), JSON.stringify(contract, null, 2));

  const htmlPath = reportHtmlPath();
  writeFileSync(htmlPath, H.join("\n"));

  console.log(`\n=== Report (${s.generated_from}, as of ${s.as_of}) ===`);
  console.log(`  confirmed ${s.counts.confirmed} (${big(s.confirmed_usd)}) · pending ${s.counts.needs_selection} (${big(s.pending_usd)}) · not-on-mp ${s.counts.not_on_marketplace} (${big(s.not_on_marketplace_usd)})`);
  console.log(`  → ${htmlPath} · ${mdPath} · ${reportJsonPath()} (contract)`);
}

main();

/** The dashboard notice for failed checks, or "" if everything passed. */
function dataNotice(checks: { mcpShape: { ok: boolean; itemsDropped: number; issues: { problem: string }[] }; render?: { ok: boolean; problems: string[] } }): string {
  const parts: string[] = [];
  if (!checks.mcpShape.ok) {
    const dropped = checks.mcpShape.itemsDropped;
    parts.push(`<p><strong>Some AWS Marketplace details came back in an unexpected format.</strong> `
      + `${dropped ? `${dropped} Marketplace listing${dropped === 1 ? " was" : "s were"} left out, and some` : "Some"} product details may show as "–". `
      + `Your figures from SaaS Manager (ACV, Accounts, renewal dates) aren't affected. Ask your agent to run <code>npm run check-mcp</code>, and let your 1Password account team know.</p>`
      + `<ul>${checks.mcpShape.issues.slice(0, 3).map((i) => `<li>${esc(i.problem)}</li>`).join("")}</ul>`);
  }
  if (checks.render && !checks.render.ok) {
    parts.push(`<p><strong>Parts of this dashboard may not display correctly.</strong> Ask your agent to regenerate it; if this notice stays, let your 1Password account team know.</p>`
      + `<ul>${checks.render.problems.slice(0, 3).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`);
  }
  return parts.length ? `<div class="data-notice" role="status">${parts.join("")}</div>` : "";
}

/**
 * The dashboard's invitation to connect the user's AWS profile for the Agreements view, worded for
 * why it isn't connected: no profile yet, a profile without the agreement permissions, or another error.
 */
function agreementsInvite(reason: string, markedN: number): { title: string; body: string } {
  const profile = configuredProfile();
  const benefit = "this dashboard finds the applications you already buy through AWS Marketplace, with what you've committed and when each agreement ends, and moves them out of the opportunities below automatically";
  const now = markedN
    ? "Until then, only the applications you mark as already on AWS Marketplace are left out below."
    : "Until then, applications you already buy through AWS Marketplace are still counted below; mark them on their row or tell your agent.";
  if (!profile) {
    return {
      title: "See what you already buy on AWS Marketplace.",
      body: `You haven't connected your AWS profile yet. With a read-only AWS profile from your own AWS account, ${benefit}. Ask your agent to set it up (it takes a few minutes). ${now}`,
    };
  }
  if (/SearchAgreements|DescribeAgreement|permission|Access denied/i.test(reason)) {
    return {
      title: "See what you already buy on AWS Marketplace.",
      body: `Your AWS profile "${profile}" is connected for matching, but it can't read your AWS Marketplace purchases yet. Ask your AWS administrator to add the aws-marketplace:SearchAgreements and aws-marketplace:DescribeAgreement permissions (both read-only; see config/discovery-iam-policy.json). With them, ${benefit}. ${now}`,
    };
  }
  return {
    title: "See what you already buy on AWS Marketplace.",
    body: `Your AWS profile "${profile}" couldn't read your AWS Marketplace purchases this time: ${reason} Once it can, ${benefit}. ${now}`,
  };
}
