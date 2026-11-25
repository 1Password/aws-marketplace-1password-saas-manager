/**
 * Shadow-IT enrichment.
 *
 * For each no-contract app the BUYER has confirmed is shadow IT (recorded in
 * shadow-it.json), suggest a Marketplace product to buy + its buy / private-offer
 * URLs, via a Marketplace MCP search (see shadowIt.ts). Buy is a valid CTA only for
 * this class — used, no contract. Apps the buyer hasn't marked are left alone (the
 * default action stays "upload a contract").
 *
 * Reads:  out/<provider>/match-results.json (noContractApps) + shadow-it.json
 * Writes: out/<provider>/shadow-it-suggestions.json  ({ [app]: ShadowItSuggestion })
 *
 * Run:  [SAAS_PROVIDER=…] node --env-file=.env --import tsx src/enrichShadowIt.ts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpClient } from "./mcpClient.js";
import { suggestShadowItProduct, type ShadowItInput, type ShadowItSuggestion } from "./shadowIt.js";
import { matchResultsPath, shadowItPath, shadowItSuggestionsPath } from "./paths.js";
import { safeErrorMessage } from "./untrusted.js";

const MARKETPLACE_MCP_URL = process.env.MARKETPLACE_MCP_URL ?? "https://marketplace-mcp.us-east-1.api.aws/mcp";

async function main() {
  const decPath = shadowItPath();
  const decisions: Record<string, boolean> = existsSync(decPath) ? JSON.parse(readFileSync(decPath, "utf8")) : {};
  const flagged = Object.keys(decisions).filter((k) => decisions[k]);

  const outPath = shadowItSuggestionsPath();
  if (flagged.length === 0) {
    writeFileSync(outPath, JSON.stringify({}, null, 2));
    console.log(`\n=== Shadow-IT suggestions ===\n  No apps marked as shadow IT (${decPath}); nothing to suggest.\n  → ${outPath}`);
    return;
  }

  const match = JSON.parse(readFileSync(matchResultsPath(), "utf8"));
  const byName = new Map<string, ShadowItInput>();
  for (const a of match.noContractApps ?? []) byName.set(String(a.name).toLowerCase(), a);

  const client = new McpClient({ url: MARKETPLACE_MCP_URL, clientName: "consolidation-agent-shadowit" });
  await client.connect();

  const out: Record<string, ShadowItSuggestion> = {};
  for (const app of flagged) {
    const input = byName.get(app.toLowerCase()) ?? { name: app };
    out[app] = await suggestShadowItProduct(input, client);
    const s = out[app];
    console.error(`  ${app}: ${s.found ? `→ ${s.suggested?.title}${s.procurementUrl ? " (buy)" : ""}${s.privateOfferUrl ? " (private offer)" : ""}` : "no Marketplace match"}`);
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2));
  const withBuy = Object.values(out).filter((s) => s.procurementUrl).length;
  console.log(`\n=== Shadow-IT suggestions (${flagged.length} confirmed) ===`);
  console.log(`  ${Object.values(out).filter((s) => s.found).length} matched · ${withBuy} with a buy URL`);
  console.log(`  → ${outPath}`);
}

main().catch((err) => { console.error(`ERROR: enrichShadowIt failed: ${safeErrorMessage(err)}`); process.exitCode = 1; });
