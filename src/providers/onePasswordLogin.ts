/**
 * `npm run login` / `npm run status` — store and verify SaaS Manager API credentials.
 *
 * The bundle used to lean on `sm-mcp login` / `sm-mcp status` for this; these two
 * commands keep that exact shape so the README steps read the same:
 *
 *   npm run login -- --host trelica.app --client-id <YOUR_CLIENT_ID>
 *     (paste the client secret when prompted; it is read from stdin, never from argv,
 *      so it stays off your shell history)
 *   npm run status
 *     Host:      https://trelica.app
 *     Client ID: …
 *     Token:     ok (expires …)
 *     API:       ok (GET /api/apps/v1 -> 200)
 *
 * Flags mirror sm-mcp: --host, --client-id, --client-secret-stdin (default and only
 * mode), --no-verify (skip minting a token before saving), and `logout` to remove.
 */

import readline from "node:readline";
import {
  DEFAULT_HOST,
  CREDENTIAL_STORE,
  OnePasswordClient,
  credentialSource,
  deleteCredentials,
  missingCredentialsMessage,
  loadCredentials,
  saveCredentials,
  type SaaSManagerCredentials,
} from "./onePasswordClient.js";
import { safeErrorMessage } from "../untrusted.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
const has = (name: string) => process.argv.includes(name);

/** Read one line from stdin. On a TTY, prompt with echo suppressed. */
function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => resolve(buf.split(/\r?\n/)[0].trim()));
      process.stdin.on("error", reject);
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const anyRl = rl as any;
  anyRl._writeToOutput = (s: string) => {
    if (s.includes(prompt)) anyRl.output.write(prompt); // show the prompt, not the keystrokes
  };
  return new Promise((resolve) =>
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    }),
  );
}

async function login(): Promise<void> {
  const host = (arg("--host") ?? DEFAULT_HOST).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const clientId = arg("--client-id");
  if (!clientId) {
    console.error("--client-id is required (find it in SaaS Manager under Settings › API Access).");
    process.exit(2);
  }
  const clientSecret = await readSecret("Client secret: ");
  if (!clientSecret) {
    console.error("No client secret provided.");
    process.exit(2);
  }
  const creds: SaaSManagerCredentials = { host, clientId, clientSecret };

  if (!has("--no-verify")) {
    const client = new OnePasswordClient({ credentials: creds });
    try {
      await client.connect(); // mints a token — proves the id/secret pair is valid
      await client.get("/api/apps/v1", { limit: 1 }); // proves Apps.Read
    } catch (e) {
      console.error(`credential verification failed (use --no-verify to skip): ${safeErrorMessage(e)}`);
      process.exit(1);
    }
  }
  try {
    saveCredentials(creds);
  } catch (e) {
    console.error(safeErrorMessage(e));
    process.exit(1);
  }
  console.log(`Credentials stored in ${CREDENTIAL_STORE} for ${clientId} @ https://${host}.`);
  console.log("Verify any time with `npm run status`.");
  if (process.env.ONEPASSWORD_SM_CLIENT_SECRET) {
    console.log(`Note: ONEPASSWORD_SM_CLIENT_SECRET is also set in ${credentialSource()}, and that takes precedence over the keychain.`);
  }
}

async function status(): Promise<void> {
  let creds;
  try {
    creds = loadCredentials();
  } catch (e) {
    console.log(safeErrorMessage(e));
    process.exit(1);
  }
  if (!creds) {
    console.log(missingCredentialsMessage());
    process.exit(1);
  }
  console.log(`Source:    ${credentialSource()}`);
  console.log(`Host:      https://${creds.host}`);
  console.log(`Client ID: ${creds.clientId}`);
  const client = new OnePasswordClient({ credentials: creds });
  try {
    await client.connect();
    console.log(`Token:     ok (expires ${client.tokenExpiresAt?.toISOString()})`);
  } catch (e) {
    console.log(`Token:     FAILED — ${safeErrorMessage(e)}`);
    process.exit(1);
  }
  try {
    await client.get("/api/apps/v1", { limit: 1 });
    console.log("API:       ok (GET /api/apps/v1 -> 200)");
  } catch (e) {
    console.log(`API:       FAILED — ${safeErrorMessage(e)}`);
    process.exit(1);
  }
}

function logout(): void {
  console.log(deleteCredentials() ? "Credentials removed." : "No stored credentials to remove.");
}

const cmd = process.argv[2];
if (cmd === "login") login();
else if (cmd === "status") status();
else if (cmd === "logout") logout();
else {
  console.error("usage: npm run login -- --host <host> --client-id <id>   |   npm run status   |   npm run logout");
  process.exit(2);
}
