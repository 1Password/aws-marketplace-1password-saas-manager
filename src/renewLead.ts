/**
 * "Renew on Marketplace" lead-capture form (CLI).
 *
 * Reads the active provider's report.json, lets the buyer pick a confirmed
 * (already-owned, matched) app to renew on AWS Marketplace, asks a short set of
 * private-offer-style questions, saves the lead, and opens a prefilled mailto to
 * the customer-advisor inbox (fixed by the bundle: leadRecipient in config/bundle.json).
 *
 * A web UX, if we build one, reuses src/lead.ts and swaps this readline flow for
 * a form + POST — the lead shape and delivery stay the same.
 *
 * Run:  npm run renew-lead [--app "App Name"] [--no-open]
 *       SAAS_PROVIDER=<provider> npm run renew-lead
 */

import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, platform } from "node:process";
import { reportJsonPath } from "./paths.js";
import {
  LeadContext,
  LeadRecord,
  leadRecipient,
  renewSubject,
  renewBodyFromLead,
  buildMailto,
  saveLead,
  normalizeAndValidateContact,
} from "./lead.js";

interface ContractApp {
  app: string;
  vendor?: string;
  status: string;
  annualSpend?: number;
  seats?: number;
  renewal?: { date?: string };
  resolved?: { title?: string; listingId?: string; actions?: { listingUrl?: string } };
}
interface ReportJson { generatedFrom: string; asOf: string; apps: ContractApp[] }

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (f: string) => process.argv.includes(f);
const money = (n?: number) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

async function main() {
  const path = reportJsonPath();
  if (!existsSync(path)) {
    console.error(`No report found at ${path}. Run the ingest→analyze→report pipeline first.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as ReportJson;
  // Renewal leads apply to confirmed (owned + matched to a specific Marketplace product) apps.
  const confirmed = report.apps.filter((a) => a.status === "confirmed");
  if (!confirmed.length) {
    console.error("No confirmed apps to renew. Confirm a product first (selections.json), then re-run.");
    process.exit(1);
  }

  // Line-queue over readline (instead of rl.question) so the form behaves the same
  // whether a human types into a TTY or answers are piped in for automated testing —
  // rl.question read-ahead drops buffered lines when a pipe delivers everything at once.
  const rl = createInterface({ input: stdin, output: stdout });
  const queued: string[] = [];
  const waiters: ((s: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line); else queued.push(line);
  });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()!(null); });
  const readLine = (): Promise<string | null> => {
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((res) => waiters.push(res));
  };
  const ask = async (q: string, def = "") => {
    stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
    const line = await readLine();
    const a = (line ?? "").trim();
    return a || def;
  };
  const askYesNo = async (q: string, defYes = true) => {
    stdout.write(`${q} (${defYes ? "Y/n" : "y/N"}): `);
    const a = (await readLine() ?? "").trim().toLowerCase();
    if (!a) return defYes;
    return a.startsWith("y");
  };

  try {
    // 1. Pick the app to renew.
    let picked: ContractApp | undefined;
    const wanted = arg("--app");
    if (wanted) {
      picked = confirmed.find((a) => a.app.toLowerCase() === wanted.toLowerCase());
      if (!picked) { console.error(`"${wanted}" is not a confirmed app in ${report.generatedFrom}.`); process.exit(1); }
    } else {
      console.log(`\nRenew on AWS Marketplace — pick an app (${report.generatedFrom}, as of ${report.asOf}):\n`);
      const sorted = [...confirmed].sort((x, y) => (y.annualSpend ?? 0) - (x.annualSpend ?? 0));
      sorted.slice(0, 40).forEach((a, i) =>
        console.log(`  [${i + 1}] ${a.app} — ${money(a.annualSpend)}/yr · renews ${a.renewal?.date ?? "?"} · ${a.resolved?.title ?? a.vendor ?? ""}`),
      );
      const n = Number(await ask("\nEnter a number"));
      picked = sorted[n - 1];
      if (!picked) { console.error("Invalid choice."); process.exit(1); }
    }

    const ctx: LeadContext = {
      app: picked.app,
      vendor: picked.vendor ?? null,
      product: picked.resolved?.title ?? null,
      listingId: picked.resolved?.listingId ?? null,
      listingUrl: picked.resolved?.actions?.listingUrl ?? null,
      annualSpend: picked.annualSpend ?? null,
      seats: picked.seats ?? null,
      renewalDate: picked.renewal?.date ?? null,
      provider: report.generatedFrom,
      asOf: report.asOf,
    };

    console.log(`\nRenewing: ${ctx.app} — ${ctx.product ?? ctx.vendor ?? ""}`);
    console.log(`Current annual spend ${money(ctx.annualSpend ?? undefined)} · renews ${ctx.renewalDate ?? "unknown"}\n`);
    console.log(`A few questions (mirrors an AWS Marketplace private-offer request) so the AWS customer-advisor team can help:\n`);

    // 2. Buyer contact + preferences (private-offer bar: required until valid).
    // Re-ask a field until normalizeAndValidateContact accepts the answer for it.
    const askUntilValid = async (q: string, field: string, def = ""): Promise<string> => {
      while (true) {
        const val = await ask(q, def);
        const v = normalizeAndValidateContact({ [field]: val });
        // Only fail on THIS field's own errors (other required fields are still blank here).
        const own = v.errors.filter((e) => e.toLowerCase().includes(field.toLowerCase()) || (field === "businessEmail" && e.toLowerCase().includes("email")) || (field === "awsAccountId" && e.toLowerCase().includes("account")));
        if (!own.length) return val;
        own.forEach((e) => console.log(`  ! ${e}`));
      }
    };

    const buyerName = await askUntilValid("Your full name", "buyerName");
    const businessEmail = await askUntilValid("Business email", "businessEmail");
    const company = await askUntilValid("Company", "company");
    const awsAccountId = await askUntilValid("AWS account ID (12 digits — the renewal is created against this account)", "awsAccountId");
    const jobTitle = await ask("Job title (optional)");
    const phone = await ask("Phone (optional, Enter to skip)");
    const desiredTerm = await ask("Desired contract term", "12 months");
    const notes = await ask("Anything specific you'd like help with? (optional)");
    const consentToContact = await askYesNo("OK for the AWS customer-advisor team to contact you about this renewal?", true);
    if (!consentToContact) {
      console.error("\nWithout consent to be contacted we can't route this to the advisor team. Aborting — nothing saved or sent.");
      process.exit(1);
    }

    // Validate the whole contact against the private-offer bar (aliases, formats, required).
    const v = normalizeAndValidateContact({ buyerName, businessEmail, company, awsAccountId, jobTitle, phone, desiredTerm, notes, consentToContact });
    if (!v.ok) {
      console.error(`\nCan't capture this lead:\n${v.errors.map((e) => `  ! ${e}`).join("\n")}\nRe-run to try again — nothing saved or sent.`);
      process.exit(1);
    }

    const lead: LeadRecord = {
      kind: "renewal",
      ...ctx,
      contact: v.contact!,
      capturedAt: new Date().toISOString(),
    };

    // 3. Confirm before anything is saved or sent — the renewal facts come from the
    // buyer's own data, so let them review the full lead and approve or abort.
    const recipient = leadRecipient();
    console.log(`\n${"═".repeat(60)}\nReview the lead that will go to the AWS Marketplace team (${recipient}):\n`);
    console.log(renewBodyFromLead(lead));
    console.log(`${"═".repeat(60)}`);
    const send = await askYesNo("\nSend this to the AWS Marketplace team as-is?", true);
    if (!send) {
      console.error("Not sent. Re-run to edit the details — nothing saved or sent.");
      process.exit(1);
    }

    const savedPath = saveLead(lead);
    const mailto = buildMailto(recipient, renewSubject(ctx), renewBodyFromLead(lead));

    console.log(`\n✓ Lead captured → ${savedPath}`);
    console.log(`✉  Emailing to ${recipient} …`);

    if (!flag("--no-open")) {
      const opener = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
      execFile(opener, [mailto], (err) => {
        if (err) {
          console.log(`\nCouldn't auto-open your mail client. Open this link to send:\n${mailto}\n`);
        } else {
          console.log(`Opened your mail client — review and hit Send.`);
        }
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
