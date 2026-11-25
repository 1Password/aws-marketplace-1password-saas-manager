/**
 * Capability detection — the layer that drives everything downstream.
 *
 * Runs all four probes in parallel, then walks the tier ladder to determine
 * the highest tier the buyer currently qualifies for and what they should
 * connect next. check_setup and `npm run detect` report it.
 */

import { TIERS } from "./sources.js";
import {
  probeDiscoveryApi,
  probeAgreementsApi,
  probeMarketplaceMcp,
  probeSaaSSource,
} from "./probes.js";
import type { CapabilitySnapshot, SourceRole, SourceStatus, TierDefinition } from "./types.js";

/** Probe every role concurrently. The saas-source role uses the active provider. */
export async function detectSources(): Promise<SourceStatus[]> {
  return Promise.all([
    probeSaaSSource(),
    probeMarketplaceMcp(),
    probeDiscoveryApi(),
    probeAgreementsApi(),
  ]);
}

/** Given what's connected, compute current tier + guidance to the next one. */
export function computeSnapshot(statuses: SourceStatus[]): CapabilitySnapshot {
  const connected = new Set<SourceRole>(
    statuses.filter((s) => s.connected).map((s) => s.role),
  );

  const isReachable = (tier: TierDefinition) =>
    tier.requires.every((r) => connected.has(r));

  // Highest tier whose requirements are all met. TIERS is ordered low→high,
  // and "none" has no requirements so this always finds at least "none".
  let currentTier = TIERS[0];
  for (const tier of TIERS) {
    if (isReachable(tier)) currentTier = tier;
  }

  const currentIdx = TIERS.findIndex((t) => t.id === currentTier.id);
  const nextTier = TIERS[currentIdx + 1];
  const missingForNext = nextTier
    ? nextTier.requires.filter((r) => !connected.has(r))
    : [];

  return {
    statuses,
    currentTier: currentTier.id,
    nextTier,
    missingForNext,
  };
}

/** Convenience: probe + compute in one call. */
export async function detect(): Promise<CapabilitySnapshot> {
  return computeSnapshot(await detectSources());
}
