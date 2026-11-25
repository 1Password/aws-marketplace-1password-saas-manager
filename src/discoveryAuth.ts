/**
 * Credentials for the AWS Marketplace Discovery API: the customer's own AWS profile.
 *
 * The bundle ships no AWS key. Discovery is used only when the customer has set `AWS_PROFILE` in
 * `.env` to a profile with read-only AWS Marketplace access; otherwise matching uses the public
 * AWS Marketplace MCP instead (catalog.ts decides). Calls go through the AWS SDK for JavaScript,
 * so no AWS CLI is needed to make them (only, optionally, to create the profile).
 *
 * The SDK reads the profile from ~/.aws/ itself: credentials never pass through this code, are
 * never logged, and never go on a command line.
 */

import { MarketplaceDiscoveryClient } from "@aws-sdk/client-marketplace-discovery";
import { awsClientConfig } from "./awsClients.js";

export interface DiscoveryAuth {
  mode: "profile";
  /** SDK client for the Discovery API, signed with the customer's profile. */
  client: MarketplaceDiscoveryClient;
  /** Human-facing description for errors and check_setup — never contains a secret. */
  describe: string;
}

/** The AWS profile the customer set in `.env`, or undefined if none. */
export function configuredProfile(): string | undefined {
  const p = (process.env.AWS_PROFILE ?? "").trim();
  return p || undefined;
}

let cached: DiscoveryAuth | undefined;

/** The Discovery client for the customer's profile. Throws if no profile is set. */
export function discoveryAuth(): DiscoveryAuth {
  if (cached) return cached;
  const profile = configuredProfile();
  if (!profile) throw new Error("No AWS profile is set (AWS_PROFILE in .env), so the Discovery API isn't used; matching uses the AWS Marketplace MCP.");
  cached = {
    mode: "profile",
    client: new MarketplaceDiscoveryClient({ ...awsClientConfig(), profile }),
    describe: `AWS profile "${profile}"`,
  };
  return cached;
}
