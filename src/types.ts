/**
 * Shared types for 1Password SaaS Manager's AWS Marketplace Skill.
 *
 * The app keys off three ideas:
 *   1. Four data ROLES, each independently connectable. Three are AWS-side and
 *      fixed; ONE — the SaaS-management source — is PLUGGABLE (any registered
 *      provider). Nothing downstream talks to a specific vendor.
 *   2. A tiered value LADDER — what insights unlock once the right roles are live.
 *   3. A NORMALIZED portfolio schema every SaaS source is adapted into, so
 *      matching/insights never see vendor-specific field names.
 *
 */

/**
 * The four data ROLES. These are stable regardless of which vendor fills them.
 * "saas-source" is the pluggable one — any registered provider fills it.
 */
export type SourceRole =
  | "saas-source"
  | "marketplace-mcp"
  | "discovery-api"
  | "agreements-api";

/**
 * Id of a provider filling the pluggable "saas-source" role. Open string, not a
 * closed union — the provider REGISTRY (saasAdapters.ts) is the source of truth,
 * so adding a SaaS-management source never means editing this type.
 */
export type SaaSProviderId = string;

/** How a source is reached — drives which probe strategy the detector uses. */
export type SourceKind = "mcp" | "aws-api";

export interface SourceDefinition {
  role: SourceRole;
  /** Human-facing name used in guided onboarding copy. */
  label: string;
  kind: SourceKind;
  /** One-line description of what data this source contributes. */
  contributes: string;
}

/** Result of probing a single role at startup. */
export interface SourceStatus {
  role: SourceRole;
  connected: boolean;
  /** For the saas-source role: which provider was probed (the registry id). */
  provider?: SaaSProviderId;
  /** Populated on a failed probe — the buyer-facing reason + how to fix. */
  detail?: string;
  /** Raw sample the probe pulled back, when connected (for connectivity-first proof). */
  sample?: unknown;
}

/** The tiers of the value ladder, lowest to highest. */
export type TierId = "none" | "baseline" | "pricing" | "contracts";

export interface TierDefinition {
  id: TierId;
  label: string;
  /** Roles that must ALL be connected for this tier to be reachable. */
  requires: SourceRole[];
  /** What the buyer gets at this tier. */
  unlocks: string;
}

/** Snapshot of what's connected + which tier that puts the buyer at. */
export interface CapabilitySnapshot {
  statuses: SourceStatus[];
  currentTier: TierId;
  /** The next tier up, if any — drives "connect X next" guidance. */
  nextTier?: TierDefinition;
  /** Roles still needed to reach nextTier. */
  missingForNext: SourceRole[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized portfolio model (source-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One app in the buyer's portfolio, normalized away from any vendor's schema.
 * Every SaaS-source adapter maps its native records into this shape.
 */
export interface PortfolioApp {
  /** Display name of the app (e.g. "Salesforce"). Always present. */
  name: string;
  /** Vendor/publisher, when the source provides it. Strongest match signal. */
  vendor?: string;
  /**
   * Context words describing what the app IS (e.g. "privileged access identity").
   * Used to ENRICH the Marketplace match query. Sourced from whatever the
   * provider offers (e.g. a category field); NOT a vendor-specific field name.
   */
  descriptor?: string;
  /** Normalized annual spend in USD, when the source provides spend data. */
  annualSpend?: number;
  /** Next renewal/contract end date (ISO), when available. */
  renewalDate?: string;
  /** Current reseller/channel — the "already consolidated?" signal, when available. */
  reseller?: string;
  /** The original source record, for debugging / provenance. */
  raw?: unknown;
}

/**
 * Adoption / usage metrics for one app, when the source provides them.
 *
 * IMPORTANT — NOT comparable across sources. Each SaaS-management source defines "active" its own way
 * and we record which via `activeBasis`:
 *   • "activity" = accounts with tracked activity in a window (e.g. 90-day default).
 *   • "status"   = accounts the source integration currently reports active, which
 *     is NOT usage recency (some sources also don't reliably populate a last-login).
 * So ranking on adoption is apples-to-apples WITHIN a source, not across sources.
 */
export interface AdoptionMetrics {
  /** Provisioned accounts / seats in use, when the source provides it. */
  provisionedUsers?: number;
  /** Accounts the source counts as active — meaning per `activeBasis`. */
  activeUsers?: number;
  /** What `activeUsers` means for this source. */
  activeBasis?: "activity" | "status";
  /** % of provisioned that are active (source's own definition of active). */
  pctActive?: number;
  /** Last recorded activity date (ISO), when the source reliably tracks it. */
  lastActivityDate?: string;
}

/**
 * An app the buyer USES but has no contract on record for. Adoption-only: there's
 * no contract, so no spend / renewal figure exists (absent, not zero). Drives the
 * "upload a contract, or this may be shadow IT" callout. Detected per source: some
 * expose a native no-contract flag; others infer it (an app has accounts but no
 * contract for its vendor). Where a source has no separate spend feed, a missing
 * contract also means no spend signal at all.
 */
export interface NoContractApp {
  name: string;
  vendor?: string;
  descriptor?: string;
  adoption?: AdoptionMetrics;
  /** SaaS Manager app status (New, InReview, Managed, Accepted, PlanToClose, Closed, Ignored). */
  status?: string;
}

/**
 * A portfolio app aggregated across its contracts — one entry per matching unit
 * (the unit is provider-defined: an app, or a vendor when contracts are standalone). Carries
 * the summed spend plus the per-contract renewal dates the analytics layer needs.
 */
export interface PortfolioAppAgg extends PortfolioApp {
  /** How many source contracts rolled up into this entry. */
  contractCount: number;
  /** Every contract renewal date for this app (ISO); analytics buckets on these. */
  renewals: string[];
  /** Summed seat/unit count across contracts (a proxy; may overcount bundles). */
  seats: number;
  /**
   * Product-bearing contract line-item descriptions (deduped, generic lines like
   * "Annual subscription" dropped). Often name the SKU the app-level record doesn't,
   * so the matcher uses them to narrow a pending app's candidate listings.
   */
  lineItemDescriptions?: string[];
  /** Adoption/usage metrics, when the source provides them (filled per source). */
  adoption?: AdoptionMetrics;
}

/**
 * Which normalized fields a given SaaS source can actually provide. Drives
 * FIELD-LEVEL capability gating: no `spend` → consolidation-dollar math can't
 * run; no `descriptor` → matching falls back to bare-name (lower confidence).
 */
export interface PortfolioFieldCapabilities {
  descriptor: boolean;
  vendor: boolean;
  spend: boolean;
  renewalDate: boolean;
  reseller: boolean;
  /** Source exposes adoption/usage metrics + can flag used-but-uncontracted apps. */
  adoption?: boolean;
}

/**
 * A pluggable SaaS-management source. Adding a provider = adding one of these;
 * no other file changes. Carries connection metadata, declared field
 * capabilities, and a normalize() that maps native records → PortfolioApp.
 */
export interface SaaSSourceAdapter {
  id: SaaSProviderId;
  label: string;
  contributes: string;
  /** MCP endpoint (env-overridable). */
  defaultEndpoint: string;
  endpointEnvVar: string;
  /** Env var holding the auth token, if any. */
  tokenEnvVar?: string;
  authScheme: "bearer" | "none";
  /** Which native field feeds `descriptor` — documentation for humans. */
  descriptorSource: string;
  /**
   * Buyer-facing setup steps for connecting THIS source (Markdown). Used by guided
   * onboarding. Provider-specific, so it lives on the provider (keeps other sources out
   * of a single-source bundle).
   */
  setup?: string;
  /** What normalized fields this source provides. */
  capabilities: PortfolioFieldCapabilities;
  /** Map one native app record from this source into the normalized shape. */
  normalize(nativeApp: Record<string, unknown>): PortfolioApp;
}
