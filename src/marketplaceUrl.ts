/**
 * AWS Marketplace URL attribution rewriter.
 *
 * URLs returned by the AWS Marketplace MCP (the "MAX_MCP" tooling at
 * MARKETPLACE_MCP_URL) are decorated with tracking parameters that attribute
 * clicks back to the MCP data-gathering workflow:
 *
 *   https://aws.amazon.com/marketplace/pp/prodview-xxx
 *     ?ref_=MAX_MCP
 *     &src=<workflow:marketplace_solution|search_solutions|related_solutions|…>
 *     &rid=<request-id>
 *     &sid=<session-id>
 *
 * When this bundle surfaces one of those URLs to the buyer (in the HTML / MD
 * report, in the lead body, via the MCP tools), the click should attribute to
 * the SaaS-management product surfacing the recommendation — not to MCP tooling.
 * This helper strips the four MAX_MCP attribution params and sets the bundle's
 * `ref_` + `src`.
 *
 * Defaults identify this bundle (1Password SaaS Manager → consolidation
 * agent). Override per deployment via env:
 *   • MARKETPLACE_URL_REF — the referrer tag (replaces `ref_=MAX_MCP`).
 *     If AWS Marketplace assigns 1Password SaaS Manager an official partner
 *     attribution code, set MARKETPLACE_URL_REF to it.
 *   • MARKETPLACE_URL_SRC — the workflow tag (replaces `src=<MCP workflow>`).
 *
 * Non-Marketplace URLs (anything not under aws.amazon.com/marketplace/) pass
 * through unchanged. Malformed URLs pass through unchanged. The rewrite is
 * idempotent — running it twice yields the same URL — so re-applying it on
 * cache reads to migrate previously-captured entries is safe.
 */

const REF = process.env.MARKETPLACE_URL_REF ?? "SaaS_Manager_1Password";
const SRC = process.env.MARKETPLACE_URL_SRC ?? "consolidation_agent";
const STRIP = ["ref_", "src", "rid", "sid"] as const;

/** Rewrite a single Marketplace URL. Returns `undefined` iff the input was nullish. */
export function rewriteMarketplaceUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url; // malformed, pass through
  }
  if (u.hostname !== "aws.amazon.com" || !u.pathname.startsWith("/marketplace")) return url;
  for (const p of STRIP) u.searchParams.delete(p);
  u.searchParams.set("ref_", REF);
  u.searchParams.set("src", SRC);
  return u.toString();
}
