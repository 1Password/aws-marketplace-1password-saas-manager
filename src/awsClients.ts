/**
 * Shared settings and error handling for every AWS SDK client in the bundle.
 *
 *   • Region is pinned to us-east-1 (egress.ts), where AWS Marketplace's APIs live.
 *   • Endpoint overrides ignored everywhere (see below and the env scrub at the top): the SDK otherwise honours AWS_ENDPOINT_URL* environment
 *     variables (and endpoint_url in ~/.aws/config), so anything able to edit `.env` could send
 *     Marketplace requests, signed with the access key id and any session token, to a host it
 *     controls and feed fake results back. egress.ts can't see this because it only guards fetch().
 *   • Adaptive retries (up to 10 attempts), since Discovery throttles bursts.
 *   • awsErrorText() turns SDK errors into fixed text by error name and HTTP status, so raw AWS
 *     messages never reach the agent's transcript.
 *
 * The bundle calls AWS only through the SDK (no AWS CLI), so these settings cover all AWS traffic.
 */

import { MarketplaceAgreementClient } from "@aws-sdk/client-marketplace-agreement";
import { checkedRegion } from "./egress.js";

// Endpoint overrides are removed for the whole process, not just our two clients: with an SSO or
// assume-role profile the SDK's credential providers make their own calls (SSO, STS) through internal
// clients we don't configure, and AWS_ENDPOINT_URL_SSO / _STS in `.env` could otherwise send sign-in
// tokens to another host. AWS_IGNORE_CONFIGURED_ENDPOINT_URLS also covers endpoint_url in ~/.aws/config.
for (const k of Object.keys(process.env)) if (/^AWS_ENDPOINT_URL/i.test(k)) delete process.env[k];
process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";

/** The profile the customer named in `.env` (AWS_PROFILE), for messages. Never a default. */
export const AWS_PROFILE = (process.env.AWS_PROFILE ?? "").trim() || "(none set)";

/** Base config for every AWS SDK client: us-east-1 only, endpoint overrides ignored. */
export function awsClientConfig() {
  // Adaptive retries: Discovery throttles bursts (a fresh run makes hundreds of calls), so back off
  // and pace requests instead of failing the run.
  return { region: checkedRegion(process.env.MARKETPLACE_AWS_REGION), ignoreConfiguredEndpointUrls: true, retryMode: "adaptive", maxAttempts: 10 } as const;
}

let agreements: MarketplaceAgreementClient | undefined;
/**
 * Agreements use the profile the customer named in `.env`: they are the customer's own purchases.
 * Throws if none is set, so the SDK never falls back to a default profile or ambient credentials.
 */
export function agreementClient(): MarketplaceAgreementClient {
  const profile = (process.env.AWS_PROFILE ?? "").trim();
  if (!profile) throw Object.assign(new Error("No AWS profile is set (AWS_PROFILE in .env)."), { name: "NoProfileSet" });
  agreements ??= new MarketplaceAgreementClient({ ...awsClientConfig(), profile });
  return agreements;
}

/**
 * Fixed, user-facing text for a failed AWS call. Never includes the error's own message: only its
 * name, HTTP status and (for access denied) the IAM action, which is matched to a strict pattern.
 */
export function awsErrorText(err: unknown, who = `AWS profile "${AWS_PROFILE}"`): string {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = String(e?.name ?? "");
  const status = e?.$metadata?.httpStatusCode;
  if (name === "NoProfileSet") return "No AWS profile is set (AWS_PROFILE in .env).";
  if (/^(CredentialsProviderError|ProviderError|TokenProviderError)$/.test(name)) {
    return `No usable AWS credentials for ${who}. Check that the profile exists (aws configure list-profiles) and, for SSO, sign in again.`;
  }
  if (/ExpiredToken|TokenRefreshRequired/i.test(name)) return `The AWS credentials for ${who} have expired. Sign in again and retry.`;
  if (/InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch|InvalidSignature/i.test(name)) {
    return `AWS rejected the credentials for ${who} (wrong, rotated or deleted key).`;
  }
  if (/AccessDenied|NotAuthorized|Unauthorized/i.test(name) || status === 403) {
    const action = String(e?.message ?? "").match(/\b(aws-marketplace:[A-Za-z]{1,64})\b/)?.[1];
    return action
      ? `${who} doesn't have permission for ${action}. Ask your AWS administrator to grant it.`
      : `Access denied for ${who}: a required AWS Marketplace permission is missing.`;
  }
  if (/Throttl|TooManyRequests/i.test(name) || status === 429) return "AWS Marketplace is throttling requests. Wait a minute and retry.";
  if (/EgressBlocked/.test(name)) return "Blocked an AWS call outside us-east-1. Remove MARKETPLACE_AWS_REGION from .env.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|TimeoutError|NetworkingError/i.test(`${name} ${(err as any)?.code ?? ""}`)) {
    return "Couldn't reach AWS Marketplace (network error). Check your internet connection and retry.";
  }
  if (status && status >= 500) return `AWS Marketplace returned a server error (HTTP ${status}). Retry in a few minutes.`;
  if (status) return `AWS Marketplace rejected the request (HTTP ${status}${name ? `, ${safeName(name)}` : ""}).`;
  return `The AWS Marketplace call failed${name ? ` (${safeName(name)})` : ""}.`;
}

const safeName = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
