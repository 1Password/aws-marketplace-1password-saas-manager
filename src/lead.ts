/**
 * Renewal lead capture.
 *
 * The buyer's apps in this report are already OWNED (they came from SaaS Manager),
 * so the right call-to-action is not "buy" but "renew on AWS
 * Marketplace." We capture a lead and hand it to the AWS customer-advisor team,
 * who help the buyer close the renewal on Marketplace.
 *
 * Delivery (no mail server involved): we (a) persist every lead as
 * JSON under out/<provider>/leads/, and (b) build a prefilled `mailto:` the buyer
 * (or the CLI) opens in their mail client and sends. The recipient is fixed by the
 * bundle in config/bundle.json (`leadRecipient`), so every customer's leads go to
 * the same advisor inbox; see leadRecipient() below.
 *
 * Two entry points share this module:
 *   • src/renewLead.ts  — an interactive CLI form (the richer, structured path).
 *   • src/report.ts     — a per-app "Renew on Marketplace" mailto button in the
 *                         standalone HTML/Markdown report (contact fields left for
 *                         the buyer to fill, since a static file can't prompt).
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { outDir, privateDir } from "./paths.js";

const BUNDLE_CONFIG = process.env.BUNDLE_CONFIG_FILE ?? "config/bundle.json";
/** The 1Password SaaS Manager × AWS Marketplace advisor alias. Used when config/bundle.json has no leadRecipient. */
export const DEFAULT_LEAD_RECIPIENT = "1Password-SM-AWS-Marketplace@amazon.com";
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
let recipientCache: string | undefined;

/**
 * Where every lead (renewal and new-purchase) is addressed. Static per bundle:
 * `leadRecipient` in config/bundle.json, else DEFAULT_LEAD_RECIPIENT. Deliberately
 * not read from .env, so a customer's settings can never redirect leads.
 */
export const leadRecipient = (): string => {
  if (recipientCache) return recipientCache;
  let fromConfig: string | undefined;
  if (existsSync(BUNDLE_CONFIG)) {
    try {
      fromConfig = String(JSON.parse(readFileSync(BUNDLE_CONFIG, "utf8")).leadRecipient ?? "").trim() || undefined;
    } catch (e) {
      throw new Error(`${BUNDLE_CONFIG} is not valid JSON.`);
    }
    if (fromConfig && !EMAIL.test(fromConfig)) throw new Error(`${BUNDLE_CONFIG}: leadRecipient "${fromConfig}" is not an email address.`);
  }
  recipientCache = fromConfig || DEFAULT_LEAD_RECIPIENT;
  return recipientCache;
};

/**
 * The product context a lead is about (source-agnostic — filled from report data).
 * For a RENEWAL this is a confirmed, owned app (spend/seats/renewalDate populated).
 * For a NEW_PURCHASE this is a comparable Marketplace product the buyer does NOT own
 * (surfaced in the comparison widget): spend/seats/renewalDate are null, and
 * `comparedToApp` names the owned app the comparison was anchored on.
 */
export interface LeadContext {
  app: string;
  vendor?: string | null;
  /** Resolved Marketplace product title, if a specific listing is settled. */
  product?: string | null;
  listingId?: string | null;
  listingUrl?: string | null;
  annualSpend?: number | null;
  seats?: number | null;
  renewalDate?: string | null;
  /** NEW_PURCHASE only: the owned app this product was compared against. */
  comparedToApp?: string | null;
  /** Portfolio source label (the active provider's display name). */
  provider: string;
  asOf: string;
}

/**
 * Buyer-supplied answers. The required set mirrors an AWS Marketplace private-offer /
 * seller-contact request so a captured lead maps cleanly into AWS systems: full name,
 * business email, company, AWS account id (a private offer/renewal is created against a
 * specific account), and consent to be contacted. Job title/phone/term/notes are optional.
 */
export interface LeadContact {
  buyerName: string;
  businessEmail: string;
  company: string;
  awsAccountId: string;
  jobTitle?: string;
  phone?: string;
  desiredTerm?: string;
  notes?: string;
  consentToContact: boolean;
}

/** Canonical contact field names accepted on a lead (unknown keys are rejected). */
export const LEAD_CONTACT_FIELDS = [
  "buyerName", "businessEmail", "company", "awsAccountId",
  "jobTitle", "phone", "desiredTerm", "notes", "consentToContact",
] as const;

/** Forgiving aliases → canonical, so the natural buyer-facing wording just works. */
export const LEAD_CONTACT_ALIASES: Record<string, string> = {
  name: "buyerName", fullName: "buyerName",
  email: "businessEmail", workEmail: "businessEmail",
  organization: "company", organisation: "company",
  awsAccount: "awsAccountId", accountId: "awsAccountId", awsAccountID: "awsAccountId",
  title: "jobTitle", role: "jobTitle",
  consent: "consentToContact", consentToBeContacted: "consentToContact",
};

export interface LeadValidationResult {
  ok: boolean;
  errors: string[];
  contact?: LeadContact;
}

/**
 * Normalize + validate a raw contact object against the private-offer bar. Applies
 * aliases (name→buyerName, email→businessEmail, …), rejects unknown fields, and enforces
 * the required set (name, business email, company, 12-digit AWS account id, consent=true)
 * with an email-format and account-id-format check. Returns a clean LeadContact or errors.
 * Shared by the MCP server and the CLI so both enforce exactly the same contract.
 */
export function normalizeAndValidateContact(raw: Record<string, unknown>): LeadValidationResult {
  const errors: string[] = [];
  const src: Record<string, unknown> = { ...raw };

  // Apply aliases (only fill the canonical key if it isn't already set).
  for (const [alias, canon] of Object.entries(LEAD_CONTACT_ALIASES)) {
    if (alias in src) {
      const cur = src[canon];
      if (cur == null || cur === "") src[canon] = src[alias];
      delete src[alias];
    }
  }

  // Reject anything that isn't a known contact field (catches silently-dropped typos).
  const allowed = new Set<string>(LEAD_CONTACT_FIELDS);
  for (const k of Object.keys(src)) {
    if (!allowed.has(k)) {
      errors.push(`Unexpected field "${k}". Allowed: ${LEAD_CONTACT_FIELDS.join(", ")} (aliases: name→buyerName, email→businessEmail).`);
    }
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
  const buyerName = str(src.buyerName);
  const businessEmail = str(src.businessEmail);
  const company = str(src.company);
  const awsDigits = str(src.awsAccountId).replace(/[\s-]/g, "");
  const consent = src.consentToContact;

  if (!buyerName) errors.push("Full name (buyerName) is required.");
  if (!businessEmail) errors.push("Business email (businessEmail) is required.");
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(businessEmail)) errors.push(`Business email "${businessEmail}" is not a valid email address.`);
  if (!company) errors.push("Company is required.");
  if (!awsDigits) errors.push("AWS account ID (awsAccountId) is required — a Marketplace private offer/renewal is created against a specific AWS account.");
  else if (!/^\d{12}$/.test(awsDigits)) errors.push(`AWS account ID "${str(src.awsAccountId)}" must be 12 digits.`);
  if (consent !== true) errors.push("consentToContact must be true — the AWS customer-advisor team can only follow up with the buyer's consent.");

  if (errors.length) return { ok: false, errors };
  const contact: LeadContact = {
    buyerName, businessEmail, company, awsAccountId: awsDigits,
    jobTitle: str(src.jobTitle) || undefined,
    phone: str(src.phone) || undefined,
    desiredTerm: str(src.desiredTerm) || undefined,
    notes: str(src.notes) || undefined,
    consentToContact: true,
  };
  return { ok: true, errors: [], contact };
}

export interface LeadRecord extends LeadContext {
  /** "renewal" = owned app renewing on Marketplace; "new_purchase" = a comparable
   * product the buyer wants to discuss buying (from the comparison widget). */
  kind: "renewal" | "new_purchase";
  contact: LeadContact;
  capturedAt: string;
}

const money = (n?: number | null) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString()}`;

/** Email subject line for a renewal lead. */
export function renewSubject(ctx: LeadContext): string {
  return `AWS Marketplace renewal lead — ${ctx.app}`;
}

/** The renewal / product facts, rendered as email lines (shared by both bodies). */
function contextLines(ctx: LeadContext): string[] {
  return [
    `Application:            ${ctx.app}`,
    `Vendor:                 ${ctx.vendor ?? "—"}`,
    `Marketplace product:    ${ctx.product ?? "(to be confirmed)"}`,
    ctx.listingId ? `Marketplace listing ID: ${ctx.listingId}` : "",
    `Current annual spend:   ${money(ctx.annualSpend)}`,
    ctx.seats ? `Seats / units:          ${Math.round(ctx.seats).toLocaleString()}` : "",
    `Renewal date:           ${ctx.renewalDate ?? "unknown"}`,
    ctx.listingUrl ? `Listing:                ${ctx.listingUrl}` : "",
    `Portfolio source:       ${ctx.provider} (figures as of ${ctx.asOf})`,
  ].filter(Boolean);
}

/**
 * Body for the report's mailto button: renewal facts prefilled, contact fields
 * left as blanks for the buyer to complete before sending (a static HTML file
 * can't run a prompt).
 */
export function renewBodyTemplate(ctx: LeadContext): string {
  return [
    `I'd like help renewing this subscription on AWS Marketplace. Please have the`,
    `AWS customer-advisor team reach out.`,
    ``,
    `— Renewal details ${"—".repeat(20)}`,
    ...contextLines(ctx),
    ``,
    `— Your details (please complete) ${"—".repeat(8)}`,
    `Your name:`,
    `Business email:`,
    `Company:`,
    `AWS account ID (required — the renewal is created against this account):`,
    `Job title (optional):`,
    `Phone (optional):`,
    `Desired contract term:`,
    `Anything specific you'd like help with:`,
  ].join("\n");
}

/** Body for a fully captured lead (CLI form). */
export function renewBodyFromLead(lead: LeadRecord): string {
  const c = lead.contact;
  return [
    `A buyer requested help renewing a subscription on AWS Marketplace.`,
    ``,
    `— Renewal details ${"—".repeat(20)}`,
    ...contextLines(lead),
    ``,
    `— Buyer contact ${"—".repeat(22)}`,
    `Name:                   ${c.buyerName}`,
    `Business email:         ${c.businessEmail}`,
    `Company:                ${c.company}`,
    `Job title:              ${c.jobTitle || "—"}`,
    `AWS account ID:         ${c.awsAccountId}`,
    `Phone:                  ${c.phone || "—"}`,
    `Desired contract term:  ${c.desiredTerm || "—"}`,
    `Notes:                  ${c.notes || "—"}`,
    `OK to contact:          ${c.consentToContact ? "yes" : "NO — do not contact"}`,
    ``,
    `Captured: ${lead.capturedAt}`,
  ].join("\n");
}

// ── New-purchase leads (LF-followup 2026-09-04) ─────────────────────────────────
// A "Get in touch" on the comparison widget: the buyer wants to discuss buying a
// comparable Marketplace product they do NOT own. Same contact/validation/preview
// workflow as a renewal; distinguished by kind:"new_purchase". No spend/seats/renewal
// (unowned), so the body reflects "product of interest" + what it was compared against.

/** Email subject line for a new-purchase lead. */
export function purchaseSubject(ctx: LeadContext): string {
  return `AWS Marketplace new-purchase lead — ${ctx.product ?? ctx.app}`;
}

/** The product-of-interest facts for a new-purchase lead. */
function purchaseContextLines(ctx: LeadContext): string[] {
  return [
    `Product of interest:    ${ctx.product ?? ctx.app}`,
    `Vendor:                 ${ctx.vendor ?? "—"}`,
    ctx.listingId ? `Marketplace listing ID: ${ctx.listingId}` : "",
    ctx.listingUrl ? `Listing:                ${ctx.listingUrl}` : "",
    ctx.comparedToApp ? `Compared against (owned): ${ctx.comparedToApp}` : "",
    `Portfolio source:       ${ctx.provider} (as of ${ctx.asOf})`,
  ].filter(Boolean);
}

/** Body for the report's "Get in touch" mailto: product facts prefilled, contact blank. */
export function purchaseBodyTemplate(ctx: LeadContext): string {
  return [
    `I'd like to discuss purchasing this product on AWS Marketplace. Please have the`,
    `AWS customer-advisor team reach out.`,
    ``,
    `— Product details ${"—".repeat(20)}`,
    ...purchaseContextLines(ctx),
    ``,
    `— Your details (please complete) ${"—".repeat(8)}`,
    `Your name:`,
    `Business email:`,
    `Company:`,
    `AWS account ID (required — a private offer is created against this account):`,
    `Job title (optional):`,
    `Phone (optional):`,
    `Desired contract term:`,
    `Anything specific you'd like help with:`,
  ].join("\n");
}

/** Body for a fully captured new-purchase lead. */
export function purchaseBodyFromLead(lead: LeadRecord): string {
  const c = lead.contact;
  return [
    `A buyer requested help purchasing a new product on AWS Marketplace.`,
    ``,
    `— Product details ${"—".repeat(20)}`,
    ...purchaseContextLines(lead),
    ``,
    `— Buyer contact ${"—".repeat(22)}`,
    `Name:                   ${c.buyerName}`,
    `Business email:         ${c.businessEmail}`,
    `Company:                ${c.company}`,
    `Job title:              ${c.jobTitle || "—"}`,
    `AWS account ID:         ${c.awsAccountId}`,
    `Phone:                  ${c.phone || "—"}`,
    `Desired contract term:  ${c.desiredTerm || "—"}`,
    `Notes:                  ${c.notes || "—"}`,
    `OK to contact:          ${c.consentToContact ? "yes" : "NO — do not contact"}`,
    ``,
    `Captured: ${lead.capturedAt}`,
  ].join("\n");
}

/** Subject/body for a lead of either kind. */
export function leadSubject(lead: LeadRecord): string {
  return lead.kind === "new_purchase" ? purchaseSubject(lead) : renewSubject(lead);
}
export function leadBodyFromLead(lead: LeadRecord): string {
  return lead.kind === "new_purchase" ? purchaseBodyFromLead(lead) : renewBodyFromLead(lead);
}

/** Assemble a mailto: URL (recipient + urlencoded subject/body). */
export function buildMailto(recipient: string, subject: string, body: string): string {
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Persist a captured lead to out/<provider>/leads/ and return the file path.
 * Filename is prefixed by kind (`renewal` / `newpurchase`) so the two lead types
 * are separable on disk and can be routed differently downstream. */
export function saveLead(lead: LeadRecord): string {
  const dir = privateDir(`${outDir()}/leads`);
  const kindSlug = lead.kind === "new_purchase" ? "newpurchase" : "renewal";
  const slug = (lead.product ?? lead.app).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stamp = lead.capturedAt.replace(/[:.]/g, "-");
  const path = `${dir}/lead-${kindSlug}-${slug}-${stamp}.json`;
  writeFileSync(path, JSON.stringify(lead, null, 2), { mode: 0o600 });
  return path;
}
