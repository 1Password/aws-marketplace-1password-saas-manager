/**
 * Per-provider output paths. Every generated artifact lives under out/<provider>/
 * so each provider's reports coexist instead of clobbering each other. The
 * provider id comes from the active SaaS adapter, which is
 * env-selected (SAAS_PROVIDER) — so a run's artifacts always land in that
 * provider's folder without any per-command path wiring.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { activeSaaSProvider } from "./saasAdapters.js";

/**
 * Create a folder for the customer's data, readable only by them (0700). It holds contract figures
 * and leads (names, emails, AWS account ids), so other users on the machine mustn't be able to open
 * it. chmod as well as mkdir, so a folder made by an older version is tightened too. Windows ignores
 * the mode; its user profile folders are already private.
 */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync("out", 0o700); chmodSync(dir, 0o700); } catch { /* not supported here */ }
  return dir;
}

/** out/<provider>, created on demand, owner-only. */
export function outDir(): string {
  return privateDir(`out/${activeSaaSProvider().id}`);
}

export const matchResultsPath = () => `${outDir()}/match-results.json`;
export const analyticsResultsPath = () => `${outDir()}/analytics-results.json`;
export const reportJsonPath = () => `${outDir()}/report.json`;
export const reportMdPath = () => `${outDir()}/CONSOLIDATION-REPORT.md`;
export const reportHtmlPath = () => `${outDir()}/CONSOLIDATION-REPORT.html`;
export const selectionsPath = () => `${outDir()}/selections.json`;
export const actionsPath = () => `${outDir()}/actions.json`;
export const agreementsPath = () => `${outDir()}/agreements.json`;
export const deploymentPath = () => `${outDir()}/deployment.json`;
export const comparisonsPath = () => `${outDir()}/comparisons.json`;
/** Apps the buyer says they already buy through AWS Marketplace: { "<app>": { markedAt } }. */
export const alreadyOnMarketplacePath = () => `${outDir()}/already-on-marketplace.json`;
/** Buyer's shadow-IT decisions: { "<app>": true } for apps confirmed used-without-a-contract. */
export const shadowItPath = () => `${outDir()}/shadow-it.json`;
/** Suggested Marketplace products + CTAs for confirmed shadow-IT apps. */
export const shadowItSuggestionsPath = () => `${outDir()}/shadow-it-suggestions.json`;
/** How the AWS Marketplace MCP's responses looked in the last run (mcpShapes.ts). */
export const mcpHealthPath = () => `${outDir()}/mcp-health.json`;
/** Which catalog source the last run used, and why (catalog.ts). */
export const catalogSourcePath = () => `${outDir()}/catalog-source.json`;
