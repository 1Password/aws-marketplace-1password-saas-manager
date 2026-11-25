/**
 * Guided-UX rendering. Turns a CapabilitySnapshot into the buyer-facing
 * "here's what's connected / here's your tier / connect this next" report.
 *
 * Plain text, for the command line and the agent. A richer UI could render the
 * same CapabilitySnapshot: the shared types are the contract.
 */

import { sourceDefinitions, TIERS } from "./sources.js";
import type { CapabilitySnapshot } from "./types.js";

export function renderReport(snap: CapabilitySnapshot): string {
  const lines: string[] = [];
  const defs = sourceDefinitions();

  lines.push("═══ 1Password SaaS Manager's AWS Marketplace Skill — connection status ═══\n");

  // Per-role status.
  for (const status of snap.statuses) {
    const def = defs[status.role];
    const icon = status.connected ? "✓" : "✗";
    lines.push(`  ${icon} ${def.label}`);
    lines.push(`      ${def.contributes}`);
    if (status.detail) {
      lines.push(`      → ${status.detail}`);
    }
  }

  // Current tier.
  const tier = TIERS.find((t) => t.id === snap.currentTier)!;
  lines.push(`\n  Current tier: ${tier.label}`);
  lines.push(`  ${tier.unlocks}`);

  // Next-step guidance — the heart of progressive enhancement.
  if (snap.nextTier && snap.missingForNext.length > 0) {
    const needed = snap.missingForNext.map((role) => defs[role].label).join(" + ");
    lines.push(`\n  ▸ Connect next: ${needed}`);
    lines.push(`    Unlocks — ${snap.nextTier.unlocks}`);
  } else if (!snap.nextTier) {
    lines.push(`\n  ▸ All sources connected — you're at the top tier. 🎉`);
  }

  return lines.join("\n");
}
