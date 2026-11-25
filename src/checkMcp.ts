/**
 * `npm run check-mcp` — is the AWS Marketplace MCP still returning what the dashboard needs?
 *
 *   1. Offline: feeds mcpShapes.ts a set of deliberately changed responses (renamed fields, wrong
 *      types, bad ids, unsafe links) and checks each is cleaned rather than passed on or crashing.
 *   2. Live: calls the three MCP tools the bundle uses with fixed inputs and checks their shape.
 *
 * Exits 0 if both pass, 1 otherwise, printing what changed. No portfolio data is sent: the live
 * check searches for the fixed word "monitoring" and then looks up the listings that search returns.
 *
 * Run:  npm run check-mcp            (or add --offline to skip the live calls)
 */

import "./egress.js";
import { McpClient } from "./mcpClient.js";
import { normalizeToolResult, shapeSummary, resetShapeSummary } from "./mcpShapes.js";
import { renderProblems } from "./renderCheck.js";
import { safeErrorMessage } from "./untrusted.js";

const MCP_URL = process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); };

// ── 1. Offline: changed responses are cleaned, not passed on ─────────────────
const GOOD = "prodview-abc123def4567";
{
  const r: any = normalizeToolResult("search_aws_marketplace_solutions", { results: "oops" });
  expect(Array.isArray(r.results) && r.results.length === 0, "search: a non-list `results` should become an empty list");
}
{
  const r: any = normalizeToolResult("search_aws_marketplace_solutions", {
    results: [{ solution_id: "not-an-id", solution_name: "X" }, { solution_id: GOOD, solution_name: 42, deployed_on_aws: "yes" }],
  });
  expect(r.results.length === 1, "search: an item without a valid solution_id should be dropped");
  expect(r.results[0]?.solution_name === undefined, "search: a non-text solution_name should be removed");
  expect(r.results[0]?.deployed_on_aws === undefined, "search: a non-boolean deployed_on_aws should be removed");
}
{
  const r: any = normalizeToolResult("get_aws_marketplace_solution", {
    solutions: [{
      solution_id: GOOD, solution_name: "Good", solution_url: "javascript:alert(1)",
      call_to_action: { procurement_url: "http://insecure.example", request_for_private_offer_url: "https://aws.amazon.com/marketplace/x" },
      rankings: "top 3", reviews_summary: { average_rating: "4.5", reviews_count: 10 },
      review_sentiments: [{ sentiment_category: "ease_of_use" }], highlights: ["ok", 3],
      categories: "Security", has_standard_contract: "true",
    }],
  });
  const s = r.solutions[0];
  expect(s?.solution_url === undefined, "get: a non-https solution_url should be removed");
  expect(s?.call_to_action?.procurement_url === undefined && !!s?.call_to_action?.request_for_private_offer_url, "get: only https call-to-action links should be kept");
  expect(s?.rankings === undefined, "get: non-list rankings should be removed");
  expect(s?.reviews_summary?.average_rating === undefined && s?.reviews_summary?.reviews_count === 10, "get: a non-numeric rating should be removed, a numeric count kept");
  expect(Array.isArray(s?.review_sentiments) && s.review_sentiments.length === 0, "get: incomplete review sentiments should be dropped");
  expect(JSON.stringify(s?.highlights) === '["ok"]', "get: non-text highlights should be dropped");
  expect(s?.categories === undefined && s?.has_standard_contract === undefined, "get: wrongly typed categories / has_standard_contract should be removed");
}
{
  const r: any = normalizeToolResult("get_aws_marketplace_related_solutions", { results: [{ related_solutions: [{ solution_id: GOOD }, { id: GOOD }] }, "x"] });
  expect(r.results[0]?.related_solutions?.length === 1 && Array.isArray(r.results[1]?.related_solutions), "related: malformed entries should be dropped, not crash");
}
{
  // The dashboard's render check catches what a missing or retyped field would show.
  const ok = renderProblems(`<section id="panel-renew"><td data-acv="1200">Okta</td></section><script>var x = undefined;</script>`, ["renew"]);
  expect(ok.length === 0, "render check: a good page (with \"undefined\" only inside a script) should pass");
  const bad = renderProblems(`<section id="panel-renew"><td data-acv="NaN">undefined</td><td>[object Object]</td></section>`, ["renew", "confirm"]);
  expect(bad.length >= 3, "render check: undefined, [object Object], a non-numeric ACV and a missing tab should all be caught");
}
const offlineFailures = failures.length;
console.log(offlineFailures ? `✗ offline checks: ${offlineFailures} failed` : "✓ offline checks: changed MCP responses are cleaned, and the dashboard's render check catches broken output");

// ── 2. Live: the three tools the bundle uses ─────────────────────────────────
async function live() {
  resetShapeSummary(); // the offline fixtures above noted problems on purpose
  const c = new McpClient({ url: MCP_URL, clientName: "consolidation-agent-check" });
  await c.connect();
  const sr = await c.callTool("search_aws_marketplace_solutions", { queries: ["monitoring"], max_results: 5 });
  const hits: any[] = sr?.results ?? [];
  expect(hits.length > 0, "live search: returned no valid listings");
  expect(hits.some((h) => typeof h.solution_name === "string"), "live search: no listing has a solution_name");
  expect(hits.some((h) => typeof h.vendor_name === "string"), "live search: no listing has a vendor_name");
  expect(hits.some((h) => typeof h.deployed_on_aws === "boolean"), "live search: no listing has deployed_on_aws (used for Deployed-on-AWS without an AWS profile)");
  const ids = hits.slice(0, 2).map((h) => h.solution_id);
  if (ids.length) {
    const gr = await c.callTool("get_aws_marketplace_solution", { solution_ids: ids });
    const sols: any[] = gr?.solutions ?? [];
    expect(sols.length > 0, "live get: returned no valid listings");
    expect(sols.some((x) => typeof x.solution_url === "string"), "live get: no listing has an https solution_url");
    expect(sols.some((x) => x.call_to_action && Object.keys(x.call_to_action).length), "live get: no listing has call-to-action links");
    const rr = await c.callTool("get_aws_marketplace_related_solutions", { solution_ids: [ids[0]] });
    expect(Array.isArray(rr?.results), "live related: results is not a list");
  }
  for (const i of shapeSummary().issues) failures.push(`live: ${i.problem} (×${i.count})`);
}

if (!process.argv.includes("--offline")) {
  try {
    await live();
    const liveFailures = failures.length - offlineFailures;
    console.log(liveFailures ? `✗ live checks: ${liveFailures} problem(s)` : "✓ live checks: the AWS Marketplace MCP returns the expected shape");
  } catch (e) {
    failures.push(`live: couldn't complete the check (${safeErrorMessage(e)})`);
    console.log("✗ live checks: couldn't reach the AWS Marketplace MCP");
  }
}

if (failures.length) {
  console.log("\nWhat changed:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
