/**
 * Outbound-call allowlist. The bundle only talks to the services it needs to build the dashboard:
 *
 *   • SaaS Manager API — your portfolio and contracts (trelica.app, or trelica.eu for EU tenants)
 *   • AWS Marketplace MCP — product details, comparable products, suggestions (no sign-in)
 *   • AWS Marketplace Discovery API — product matching (AWS SDK, us-east-1 only)
 *   • AWS Marketplace Agreement API — optional, your own purchases (AWS SDK, us-east-1 only)
 *   • Only if your AWS profile uses SSO or assumes a role: AWS's own sign-in services (AWS SSO / STS),
 *     called by the AWS SDK to get that profile's credentials. Endpoint overrides are ignored for these
 *     too (awsClients.ts), so they can only go to AWS.
 *
 * Pre-filled emails make no network call from here: they open in your own email app or browser.
 * If `.env` uses 1Password secret references (op://…), the 1Password CLI reads them from your own
 * 1Password account; a 1Password Environment mounted as `.env` is served locally by the 1Password app.
 *
 * Anything else is refused before a connection is made, including a host set in `.env`
 * (ONEPASSWORD_SM_HOST, MARKETPLACE_MCP_URL) that isn't on this list, and any plain-http URL.
 * Importing this module also guards global fetch(), so code added later can't call out
 * somewhere new without being added here first. AWS SDK calls don't use fetch(); they are pinned to
 * us-east-1 and ignore AWS_ENDPOINT_URL* overrides through awsClients.ts.
 */

/** Hosts the bundle may call over HTTPS, and why. Exact host names, no wildcards. */
export const ALLOWED_HOSTS: Readonly<Record<string, string>> = {
  "trelica.app": "SaaS Manager API (US)",
  "trelica.eu": "SaaS Manager API (EU)",
  "marketplace-mcp.us-east-1.api.aws": "AWS Marketplace MCP",
};

/** The only AWS region the Marketplace APIs are called in (Discovery and Agreements live there). */
export const MARKETPLACE_REGION = "us-east-1";

export class EgressBlockedError extends Error {}

/** Return the URL if it's https to an allowed host; otherwise throw without connecting. */
export function checkedUrl(url: string | URL): string {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new EgressBlockedError(`Blocked an outbound call: "${String(url).slice(0, 80)}" isn't a valid URL.`);
  }
  if (u.protocol !== "https:") {
    throw new EgressBlockedError(`Blocked an outbound call to ${u.host}: only https is allowed.`);
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_HOSTS, u.hostname) || (u.port && u.port !== "443")) {
    throw new EgressBlockedError(
      `Blocked an outbound call to ${u.host}: this bundle only connects to ${Object.keys(ALLOWED_HOSTS).join(", ")} ` +
        `(and AWS Marketplace in ${MARKETPLACE_REGION}). Check ONEPASSWORD_SM_HOST and MARKETPLACE_MCP_URL in .env.`,
    );
  }
  return u.toString();
}

/** A SaaS Manager host (no scheme), checked against the allowlist. */
export function checkedSaaSHost(host: string): string {
  return new URL(checkedUrl(`https://${host}/`)).hostname;
}

/** The AWS region for Marketplace calls; anything but us-east-1 is refused. */
export function checkedRegion(region: string | undefined): string {
  const r = (region || MARKETPLACE_REGION).trim();
  if (r !== MARKETPLACE_REGION) {
    throw new EgressBlockedError(`Blocked AWS calls in region "${r}": AWS Marketplace calls only go to ${MARKETPLACE_REGION}. Remove MARKETPLACE_AWS_REGION from .env.`);
  }
  return r;
}

// Guard global fetch once per process: every fetch in this bundle goes through checkedUrl.
const g = globalThis as typeof globalThis & { __egressGuarded?: boolean };
if (!g.__egressGuarded && typeof g.fetch === "function") {
  const realFetch = g.fetch.bind(g);
  g.fetch = ((input: any, init?: any) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    try {
      checkedUrl(url);
    } catch (e) {
      return Promise.reject(e);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  g.__egressGuarded = true;
}
