/**
 * Entrypoint for `npm run detect`. For now this runs capability detection and prints
 * the guided report — proving the connection + tier layers end to end.
 *
 * Run with:  npm run detect
 *
 * The consolidation math lives in consolidationSummary.ts.
 */

import { detect } from "./capability.js";
import { renderReport } from "./guide.js";

async function main() {
  console.error("Probing the four data sources…\n");
  const snapshot = await detect();
  console.log(renderReport(snapshot));

  // Non-zero exit if we can't even reach the baseline — useful for scripting.
  const atLeastBaseline = snapshot.currentTier !== "none";
  process.exitCode = atLeastBaseline ? 0 : 1;
}

main().catch((err) => {
  console.error("Detection failed:", err);
  process.exitCode = 1;
});
