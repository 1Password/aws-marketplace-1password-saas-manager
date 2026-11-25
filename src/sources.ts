/**
 * Static definitions of the four ROLES and the tier ladder.
 * The roles and tiers the connection check reports against.
 *
 * Roles are vendor-neutral. The "saas-source" role's label/description comes
 * from whichever provider is active (see the provider registry).
 */

import type { SourceDefinition, TierDefinition, SourceRole } from "./types.js";
import { activeSaaSProvider } from "./saasAdapters.js";

/** Build source definitions, with the saas-source role filled by the active provider. */
export function sourceDefinitions(): Record<SourceRole, SourceDefinition> {
  const saas = activeSaaSProvider();
  return {
    "saas-source": {
      role: "saas-source",
      label: `${saas.label} (SaaS management)`,
      kind: "mcp",
      contributes: saas.contributes,
    },
    "marketplace-mcp": {
      role: "marketplace-mcp",
      label: "AWS Marketplace MCP",
      kind: "mcp",
      contributes: "The public AWS Marketplace catalog: product details, comparable products, and matching when no AWS profile is set.",
    },
    "discovery-api": {
      role: "discovery-api",
      label: "AWS Marketplace Discovery API (your AWS profile, optional)",
      kind: "aws-api",
      contributes: "More complete matching: every listing a vendor has, with categories and Deployed-on-AWS badges.",
    },
    "agreements-api": {
      role: "agreements-api",
      label: "AWS Marketplace Agreement API (your AWS profile, optional)",
      kind: "aws-api",
      contributes: "Committed spend, contract terms, co-term & renewal-optimization opportunities.",
    },
  };
}

/**
 * The value ladder. Each tier requires ALL of its roles to be connected.
 * Ordered lowest → highest; the detector walks this to find the current tier.
 * Note: requirements are ROLES, not vendors — swapping the SaaS provider does
 * not touch the ladder.
 */
export const TIERS: TierDefinition[] = [
  {
    id: "none",
    label: "Not yet connected",
    requires: [],
    unlocks: "Nothing yet — connect your SaaS-management source; the AWS Marketplace MCP needs no setup.",
  },
  {
    id: "baseline",
    label: "Baseline",
    requires: ["saas-source", "marketplace-mcp"],
    unlocks:
      "The full report: your portfolio matched to AWS Marketplace through the public MCP, with no AWS account needed.",
  },
  {
    id: "pricing",
    label: "+ Your AWS profile",
    requires: ["saas-source", "marketplace-mcp", "discovery-api"],
    unlocks:
      "The most complete matching: every listing each vendor has on AWS Marketplace, from the Discovery API.",
  },
  {
    id: "contracts",
    label: "+ Contracts",
    requires: ["saas-source", "marketplace-mcp", "discovery-api", "agreements-api"],
    unlocks:
      "Committed spend, contract terms, and co-term / renewal-optimization opportunities.",
  },
];
