/**
 * Dependency-free REST client for the 1Password SaaS Manager public API.
 * This is the analogue of the core Streamable-HTTP mcpClient.ts — the transports
 * differ, so they're separate clients behind similar surfaces.
 *
 * Auth is OAuth 2.0 client credentials against `https://<host>/connect/token`
 * (`client_secret_post`; verified via /.well-known/openid-configuration 2026-09-23).
 * Access tokens expire (~1h) and are simply re-minted on expiry or on a 401 — the
 * flow has no refresh token; the client id + secret persist.
 *
 * Credentials come from the OS credential store, written once by `npm run login`:
 * the macOS keychain, or on Windows a file encrypted to the user's Windows account
 * (DPAPI). Or from a 1Password Environment mounted as `.env`, or 1Password secret references
 * (`op://…`) in `.env` (see loadCredentials).
 *
 * We only ever GET: ingestion only lists, and least-privilege is the right default
 * for a production-adjacent tool. The API client needs exactly Apps.Read,
 * Apps.Users.Read and Contracts.Read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkedSaaSHost } from "../egress.js";

export interface SaaSManagerCredentials {
  /** API host, e.g. trelica.app (US) or trelica.eu (EU). */
  host: string;
  clientId: string;
  clientSecret: string;
}

export const DEFAULT_HOST = "trelica.app";
// Kept from the bundle's original name on purpose: renaming it would sign out everyone who already ran
// `npm run login` (macOS keychain item, and the Windows folder under %APPDATA%).
const KEYCHAIN_SERVICE = "consolidation-agent-1password";
const KEYCHAIN_ACCOUNT = "credentials";
const TOKEN_REFRESH_SKEW_MS = 60_000;

const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/** Where `npm run login` keeps the credentials, in words, for its success line. */
export const CREDENTIAL_STORE = IS_WINDOWS
  ? "Windows, encrypted to your Windows account"
  : "the OS keychain";
const CREDENTIAL_STORE_NAME = IS_WINDOWS ? "Windows credential file (npm run login)" : "macOS keychain (npm run login)";

// Windows has no `security` CLI. We use DPAPI through Windows PowerShell's
// ConvertFrom-SecureString: the file can only be decrypted by the same Windows
// user on the same machine. The secret travels over stdin, never argv.
const WIN_FILE = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), KEYCHAIN_SERVICE, "credentials.dat");
const PS_PROTECT =
  "$t=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString";
const PS_UNPROTECT =
  "$t=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString -String $t; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

function powershell(script: string, input: string) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

function parseStored(raw: string): SaaSManagerCredentials | undefined {
  try {
    const c = JSON.parse(raw.trim());
    if (c?.clientId && c?.clientSecret) return { host: checkedSaaSHost(c.host || DEFAULT_HOST), clientId: c.clientId, clientSecret: c.clientSecret };
  } catch {
    /* corrupt entry — treat as absent */
  }
  return undefined;
}

/**
 * True when `.env` is a 1Password Environment mounted as a local .env file (1Password serves it as a
 * named pipe, not a regular file). Then it must never be overwritten or edited: changes are made in
 * the Environment in 1Password, and reading it is what triggers 1Password's approval.
 */
export function envIsMounted(path = ".env"): boolean {
  try {
    return lstatSync(path).isFIFO();
  } catch {
    return false;
  }
}

/**
 * Resolve a 1Password secret reference (`op://vault/item/field`) with the 1Password CLI, so `.env`
 * can hold references instead of values. Any other value is returned unchanged. The secret is read
 * into this process only: never printed, never passed on a command line.
 */
export function resolveSecretRef(name: string, value: string): string {
  if (!value.startsWith("op://")) return value;
  const r = spawnSync("op", ["read", "--no-newline", value], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (r.error) {
    throw new Error(
      `${name} in .env is a 1Password secret reference, but the 1Password CLI (\`op\`) couldn't run. ` +
        "Install it and turn on its integration with the 1Password app (Settings › Developer).",
    );
  }
  if (r.status !== 0 || !r.stdout) {
    // Not the CLI's own error text: only fixed guidance reaches the agent.
    throw new Error(`Couldn't read ${name} from 1Password (${value}). Unlock 1Password, approve the request if asked, and check that the reference exists.`);
  }
  return r.stdout;
}

/** Where loadCredentials() found the credentials, in words, for `npm run status`. */
export function credentialSource(): string {
  if (process.env.ONEPASSWORD_SM_CLIENT_SECRET) {
    const refs = [process.env.ONEPASSWORD_SM_CLIENT_ID, process.env.ONEPASSWORD_SM_CLIENT_SECRET].some((v) => v?.startsWith("op://"));
    if (envIsMounted()) return "1Password Environment (.env mounted by 1Password)";
    return refs ? ".env, with secret references read from 1Password" : ".env (plain-text secret: not supported)";
  }
  return CREDENTIAL_STORE_NAME;
}

/**
 * Read credentials. The ONEPASSWORD_SM_* variables come first, but only from 1Password: a `.env` that
 * 1Password mounts from an Environment, or 1Password secret references (`op://…`) in `.env`. A
 * plain-text client secret in `.env` is refused, so the secret never sits unprotected on disk.
 * Otherwise the OS credential store that `npm run login` writes. Returns undefined when neither is set.
 */
export const PLAIN_SECRET_MESSAGE =
  "ONEPASSWORD_SM_CLIENT_SECRET in .env is a plain-text secret, which isn't supported. Delete that line, then either " +
  "run `npm run login` in your own terminal (stores it in the macOS keychain, or on Windows encrypted to your account), " +
  "or keep it in 1Password: a 1Password Environment that serves .env, or a secret reference (op://vault/item/field) in .env. See README step 4.";

export function loadCredentials(): SaaSManagerCredentials | undefined {
  const envSecret = process.env.ONEPASSWORD_SM_CLIENT_SECRET;
  if (envSecret) {
    if (!envIsMounted() && !envSecret.trim().startsWith("op://")) throw new Error(PLAIN_SECRET_MESSAGE);
    const clientId = process.env.ONEPASSWORD_SM_CLIENT_ID;
    if (!clientId) throw new Error("ONEPASSWORD_SM_CLIENT_SECRET is set but ONEPASSWORD_SM_CLIENT_ID is not.");
    return {
      host: checkedSaaSHost(process.env.ONEPASSWORD_SM_HOST || DEFAULT_HOST),
      clientId: resolveSecretRef("ONEPASSWORD_SM_CLIENT_ID", clientId),
      clientSecret: resolveSecretRef("ONEPASSWORD_SM_CLIENT_SECRET", envSecret),
    };
  }
  if (IS_WINDOWS) {
    if (!existsSync(WIN_FILE)) return undefined;
    const r = powershell(PS_UNPROTECT, readFileSync(WIN_FILE, "utf8"));
    if (r.error || r.status !== 0) return undefined;
    return parseStored(r.stdout);
  }
  if (!IS_MAC) return undefined;
  const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], {
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) return undefined;
  return parseStored(r.stdout);
}

/**
 * The "not connected" message, with the likeliest fix. Catches the classic Windows
 * slip from the `.env` route: the ONEPASSWORD_SM_* lines filled in but left
 * commented out with `#`, so they're ignored.
 */
export function missingCredentialsMessage(): string {
  if (envIsMounted()) {
    return "No SaaS Manager credentials found. Your .env is a 1Password Environment: in 1Password, add ONEPASSWORD_SM_CLIENT_ID and ONEPASSWORD_SM_CLIENT_SECRET (and ONEPASSWORD_SM_HOST=trelica.eu if your SaaS Manager is in the EU) to that Environment. (Or use `npm run login` instead — see setup.)";
  }
  let env = "";
  try {
    env = readFileSync(".env", "utf8");
  } catch {
    /* no .env */
  }
  if (/^[ \t]*#[ \t]*ONEPASSWORD_SM_CLIENT_SECRET[ \t]*=[ \t]*op:\/\//m.test(env)) {
    return "No SaaS Manager credentials found. The ONEPASSWORD_SM_ lines in .env hold 1Password secret references but still start with `#`, so they're ignored: delete the `#` at the start of all three lines and save the file. (Or use `npm run login` instead — see setup.)";
  }
  return "No SaaS Manager credentials found — run `npm run login` (see setup).";
}

/** Store credentials in the OS credential store (replacing any existing entry). */
export function saveCredentials(c: SaaSManagerCredentials): void {
  if (IS_WINDOWS) {
    const r = powershell(PS_PROTECT, JSON.stringify(c));
    if (r.error) throw new Error("Could not run PowerShell to save the credentials.");
    if (r.status !== 0 || !r.stdout.trim()) throw new Error(`Saving the credentials failed (PowerShell exit code ${r.status}).`);
    mkdirSync(join(WIN_FILE, ".."), { recursive: true });
    writeFileSync(WIN_FILE, r.stdout.trim() + "\n");
    return;
  }
  if (!IS_MAC) {
    throw new Error(
      "There's no supported credential store on this platform. Put ONEPASSWORD_SM_HOST, ONEPASSWORD_SM_CLIENT_ID and ONEPASSWORD_SM_CLIENT_SECRET in .env instead (see README).",
    );
  }
  // `security` takes the value as an argument; there is no stdin mode. It is briefly
  // visible to `ps` on this machine during the write — same trade-off as any CLI
  // keychain write — and never touches disk or shell history.
  const r = spawnSync(
    "security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", JSON.stringify(c)],
    { encoding: "utf8" },
  );
  if (r.error) throw new Error("Could not run the macOS `security` tool to save the credentials.");
  if (r.status !== 0) throw new Error(`Keychain write failed (security exit code ${r.status}). Unlock your login keychain and retry.`);
}

/** Remove the stored credentials. */
export function deleteCredentials(): boolean {
  if (IS_WINDOWS) {
    if (!existsSync(WIN_FILE)) return false;
    unlinkSync(WIN_FILE);
    return true;
  }
  if (!IS_MAC) return false;
  const r = spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
    encoding: "utf8",
  });
  return !r.error && r.status === 0;
}

interface AccessToken {
  value: string;
  expiresAt: number; // epoch ms
}

export class OnePasswordClient {
  private creds?: SaaSManagerCredentials;
  private token?: AccessToken;

  constructor(private readonly opts: { credentials?: SaaSManagerCredentials } = {}) {}

  /** Resolve credentials and mint the first access token (verifies them). */
  async connect(): Promise<void> {
    this.creds = this.opts.credentials ?? loadCredentials();
    if (!this.creds) {
      throw new Error(missingCredentialsMessage());
    }
    await this.mintToken();
  }

  get host(): string {
    return this.creds?.host ?? DEFAULT_HOST;
  }

  get clientId(): string | undefined {
    return this.creds?.clientId;
  }

  /** When the current access token expires (for `npm run status`). */
  get tokenExpiresAt(): Date | undefined {
    return this.token ? new Date(this.token.expiresAt) : undefined;
  }

  /**
   * GET a JSON resource. Errors carry the real HTTP status so callers can tell a
   * missing scope (403) from a bad token (401) from an outage (5xx).
   */
  async get(path: string, params: Record<string, unknown> = {}): Promise<any> {
    const url = new URL(path, `https://${this.host}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let res = await this.fetchAuthed(url);
    if (res.status === 401) {
      // Token expired (or revoked) between mint and use — re-mint once and retry.
      this.token = undefined;
      res = await this.fetchAuthed(url);
    }
    if (!res.ok) {
      // Fixed text by status; the response body is never passed on.
      throw new Error(`GET ${url.pathname} -> ${res.status}: ${httpStatusText(res.status)}`);
    }
    return res.json();
  }

  /**
   * List every page of a paginated resource. The API returns { results[], next }
   * where `next` is a URL carrying an opaque `after` cursor; we follow it until
   * exhausted (or `max` rows collected).
   */
  async listAll(
    path: string,
    opts: { pageSize?: number; max?: number; params?: Record<string, unknown> } = {},
  ): Promise<any[]> {
    const pageSize = opts.pageSize ?? 500;
    const max = opts.max ?? Infinity;
    const rows: any[] = [];
    let after: string | undefined;
    do {
      const params: Record<string, unknown> = { ...(opts.params ?? {}), limit: Math.min(pageSize, max - rows.length) };
      if (after) params.after = after;
      const page = await this.get(path, params);
      const results: any[] = page?.results ?? [];
      rows.push(...results);
      after = cursorFromNext(page?.next);
    } while (after && rows.length < max);
    return rows.slice(0, max);
  }

  /** Nothing to tear down for HTTP; kept so call sites read the same as before. */
  close(): void {}

  // ── internals ──────────────────────────────────────────────────────────────
  private async fetchAuthed(url: URL): Promise<Response> {
    const token = await this.accessToken();
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async accessToken(): Promise<string> {
    if (!this.token || Date.now() + TOKEN_REFRESH_SKEW_MS >= this.token.expiresAt) await this.mintToken();
    return this.token!.value;
  }

  private async mintToken(): Promise<void> {
    const c = this.creds!;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: c.clientId,
      client_secret: c.clientSecret,
    });
    const res = await fetch(`https://${c.host}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || !json.access_token) {
      // Only the standard OAuth error code is used, never free text from the response.
      const code = String(json.error ?? "");
      const why = code === "invalid_client" || code === "unauthorized_client"
        ? "SaaS Manager rejected the Client ID or secret"
        : code === "invalid_scope"
          ? "the API client is missing a required scope"
          : httpStatusText(res.status);
      throw new Error(`POST /connect/token -> ${res.status}: ${why}`);
    }
    const ttlSec = Number(json.expires_in) || 3600;
    this.token = { value: json.access_token, expiresAt: Date.now() + ttlSec * 1000 };
  }
}

/** Pull the opaque `after` cursor out of a `next` page URL, if present. */
function cursorFromNext(next: unknown): string | undefined {
  if (typeof next !== "string" || !next) return undefined;
  try {
    const u = new URL(next);
    return u.searchParams.get("after") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Fixed text for an HTTP status from SaaS Manager. */
function httpStatusText(status: number): string {
  if (status === 400) return "SaaS Manager rejected the request";
  if (status === 401) return "SaaS Manager rejected the credentials";
  if (status === 403) return "the API client is missing a required scope (Read apps, Read app accounts or Read contracts)";
  if (status === 404) return "not found";
  if (status === 429) return "SaaS Manager is rate-limiting requests; wait a minute and retry";
  if (status >= 500) return "SaaS Manager had a server error; retry in a few minutes";
  return "request failed";
}
