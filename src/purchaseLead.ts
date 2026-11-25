/**
 * New-purchase lead-capture form (CLI) — the "Get in touch" counterpart to renewLead.ts.
 *
 * Where renew-lead captures a lead for an owned app the buyer wants to RENEW, this
 * captures a lead for a comparable Marketplace product (from the comparison widget)
 * the buyer wants to DISCUSS BUYING — a product they do NOT own yet. Same private-offer
 * contact bar + preview-then-confirm flow; recorded with kind:"new_purchase".
 *
 * A web UX reuses src/lead.ts and swaps this readline flow for a form + POST.
 *
 * Run:  npm run purchase-lead [--no-open]
 *       SAAS_PROVIDER=<provider> npm run purchase-lead
 */

import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, platform } from "node:process";
import { reportJsonPath, comparisonsPath } from "./paths.js";
import {
  LeadContext,
  LeadRecord,
  leadRecipient,
  purchaseSubject,
  purchaseBodyFromLead,
  buildMailto,
  saveLead,
  normalizeAndValidateContact,
} from "./lead.js";

interface CmpProduct { listingId: string; name: string; vendor?: string; isSeed: boolean; url?: string }
interface Comparison { app: string; products: CmpProduct[] }
interface ReportJson { generatedFrom: string; asOf: string }

const flag = (f: string) => process.argv.includes(f);

async function main() {
  const cmpPath = comparisonsPath();
  const repPath = reportJsonPath();
  if (!existsSync(cmpPath)) {
    console.error(`No comparisons found at ${cmpPath}. Run the pipeline (incl. enrich-comparisons) first.`);
    process.exit(1);
  }
  const comparisons = JSON.parse(readFileSync(cmpPath, "utf8")) as Record<string, Comparison>;
  const report = existsSync(repPath) ? (JSON.parse(readFileSync(repPath, "utf8")) as ReportJson) : { generatedFrom: "unknown", asOf: "unknown" };

  // Flatten to a pick list of comparable (non-seed) products across all seed apps.
  const options: { seedApp: string; peer: CmpProduct }[] = [];
  for (const c of Object.values(comparisons)) {
    for (const p of c.products) if (!p.isSeed) options.push({ seedApp: c.app, peer: p });
  }
  if (!options.length) {
    console.error("No comparable products to inquire about. Run enrich-comparisons first.");
    process.exit(1);
  }

  // Line-queue over readline so it behaves the same for a human TTY and piped input.
  const rl = createInterface({ input: stdin, output: stdout });
  const queued: string[] = [];
  const waiters: ((s: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => { const w = waiters.shift(); if (w) w(line); else queued.push(line); });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()!(null); });
  const readLine = (): Promise<string | null> => {
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((res) => waiters.push(res));
  };
  const ask = async (q: string, def = "") => {
    stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
    const line = await readLine();
    return ((line ?? "").trim()) || def;
  };
  const askYesNo = async (q: string, defYes = true) => {
    stdout.write(`${q} (${defYes ? "Y/n" : "y/N"}): `);
    const a = (await readLine() ?? "").trim().toLowerCase();
    if (!a) return defYes;
    return a.startsWith("y");
  };

  try {
    // 1. Pick the comparable product to inquire about.
    console.log(`\nGet in touch about a new AWS Marketplace purchase — pick a comparable product (${report.generatedFrom}):\n`);
    options.slice(0, 60).forEach((o, i) =>
      console.log(`  [${i + 1}] ${o.peer.name}${o.peer.vendor ? ` — ${o.peer.vendor}` : ""}  (vs your ${o.seedApp})`),
    );
    const n = Number(await ask("\nEnter a number"));
    const picked = options[n - 1];
    if (!picked) { console.error("Invalid choice."); process.exit(1); }

    const ctx: LeadContext = {
      app: picked.peer.name,
      vendor: picked.peer.vendor ?? null,
      product: picked.peer.name,
      listingId: picked.peer.listingId ?? null,
      listingUrl: picked.peer.url ?? null,
      annualSpend: null, seats: null, renewalDate: null,
      comparedToApp: picked.seedApp,
      provider: report.generatedFrom,
      asOf: report.asOf,
    };

    console.log(`\nInquiring about: ${ctx.product} (${ctx.vendor ?? "—"}) — considered vs your ${ctx.comparedToApp}\n`);
    console.log(`A few questions (mirrors an AWS Marketplace private-offer request) so the AWS customer-advisor team can help:\n`);

    // 2. Buyer contact (private-offer bar: required until valid).
    const askUntilValid = async (q: string, field: string, def = ""): Promise<string> => {
      while (true) {
        const val = await ask(q, def);
        const v = normalizeAndValidateContact({ [field]: val });
        const own = v.errors.filter((e) => e.toLowerCase().includes(field.toLowerCase()) || (field === "businessEmail" && e.toLowerCase().includes("email")) || (field === "awsAccountId" && e.toLowerCase().includes("account")));
        if (!own.length) return val;
        own.forEach((e) => console.log(`  ! ${e}`));
      }
    };

    const buyerName = await askUntilValid("Your full name", "buyerName");
    const businessEmail = await askUntilValid("Business email", "businessEmail");
    const company = await askUntilValid("Company", "company");
    const awsAccountId = await askUntilValid("AWS account ID (12 digits — a private offer is created against this account)", "awsAccountId");
    const jobTitle = await ask("Job title (optional)");
    const phone = await ask("Phone (optional, Enter to skip)");
    const desiredTerm = await ask("Desired contract term", "12 months");
    const notes = await ask("Anything specific you'd like help with? (optional)");
    const consentToContact = await askYesNo("OK for the AWS customer-advisor team to contact you about this purchase?", true);
    if (!consentToContact) {
      console.error("\nWithout consent to be contacted we can't route this to the advisor team. Aborting — nothing saved or sent.");
      process.exit(1);
    }

    const v = normalizeAndValidateContact({ buyerName, businessEmail, company, awsAccountId, jobTitle, phone, desiredTerm, notes, consentToContact });
    if (!v.ok) {
      console.error(`\nCan't capture this lead:\n${v.errors.map((e) => `  ! ${e}`).join("\n")}\nRe-run to try again — nothing saved or sent.`);
      process.exit(1);
    }

    const lead: LeadRecord = { kind: "new_purchase", ...ctx, contact: v.contact!, capturedAt: new Date().toISOString() };

    // 3. Confirm before anything is saved or sent.
    const recipient = leadRecipient();
    console.log(`\n${"═".repeat(60)}\nReview the new-purchase lead that will go to the AWS Marketplace team (${recipient}):\n`);
    console.log(purchaseBodyFromLead(lead));
    console.log(`${"═".repeat(60)}`);
    const send = await askYesNo("\nSend this to the AWS Marketplace team as-is?", true);
    if (!send) {
      console.error("Not sent. Re-run to edit the details — nothing saved or sent.");
      process.exit(1);
    }

    const savedPath = saveLead(lead);
    const mailto = buildMailto(recipient, purchaseSubject(ctx), purchaseBodyFromLead(lead));

    console.log(`\n✓ New-purchase lead captured → ${savedPath}`);
    console.log(`✉  Emailing to ${recipient} …`);

    if (!flag("--no-open")) {
      const opener = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
      execFile(opener, [mailto], (err) => {
        if (err) console.log(`\nCouldn't auto-open your mail client. Open this link to send:\n${mailto}\n`);
        else console.log(`Opened your mail client — review and hit Send.`);
        process.exit(0);
      });
    } else {
      console.log(`\nmailto link (open to send):\n${mailto}\n`);
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

main();
