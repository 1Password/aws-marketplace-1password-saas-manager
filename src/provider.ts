/**
 * SaaS provider contract (provider-neutral core).
 *
 * A SaaS provider is a self-contained module under src/providers/<id>.ts. It
 * bundles three things behind one object:
 *   1. the data ADAPTER (connection metadata + capabilities + normalize()),
 *   2. how to PULL that source's portfolio into the normalized aggregate shape,
 *   3. an OPTIONAL per-provider matcher override.
 *
 * The rest of the app (analytics, report, enrichers, capability detection) only
 * ever sees this interface and the normalized data, never a specific vendor. To
 * add a SaaS-management source: drop in one provider module and register it — no shared-code
 * edits. Matching stays a shared default engine (matchVendorApp), overridable
 * per provider via `matcher` when a source needs its own tuning.
 */

import type { SaaSSourceAdapter, PortfolioAppAgg, NoContractApp } from "./types.js";
import type { CatalogSource, AppInput, VendorMatch } from "./matchVendor.js";

/** Result of pulling + aggregating a provider's portfolio. */
export interface PortfolioPull {
  /** Normalized, aggregated portfolio units ready for matching. */
  apps: PortfolioAppAgg[];
  /** How many source contracts rolled up (for reporting). */
  contractCount: number;
  /** One-line human summary of the pull (coverage/join stats), for the console. */
  note?: string;
  /**
   * Apps used but with no contract on record (adoption-only). Optional — a source
   * that can't detect this omits it, and the report degrades gracefully.
   */
  noContractApps?: NoContractApp[];
}

/** A matcher takes one normalized portfolio unit and returns its vendor-first match. */
export type PortfolioMatcher = (input: AppInput, catalog?: CatalogSource) => Promise<VendorMatch>;

/**
 * A pluggable SaaS provider = its data adapter plus the runtime behaviors the
 * orchestrator needs. Extends the pure-data adapter with pull() and an optional
 * matcher override.
 */
export interface SaaSProvider extends SaaSSourceAdapter {
  /** Pull this source's full portfolio, normalized + aggregated. */
  pull(opts: { max?: number }): Promise<PortfolioPull>;
  /** Optional per-provider matcher; when absent, the shared default is used. */
  matcher?: PortfolioMatcher;
  /**
   * Optional per-provider connectivity check for guided onboarding. When absent,
   * the default MCP-endpoint bearer probe is used. A provider whose real connection
   * differs (e.g. a local stdio bridge, not a remote bearer) supplies its own.
   */
  probeConnection?(): Promise<{ connected: boolean; detail?: string }>;
}
