# 1Password SaaS Manager's AWS Marketplace Skill

Guided AWS Marketplace consolidation for an enterprise user (the *buyer*, in AWS Marketplace terms), run locally as a
skill in **Claude Code**, **OpenAI Codex**, **Gemini CLI** or **Cursor** (or any coding agent that reads `SKILL.md` and can run shell commands on your computer). This bundle is configured for **1Password SaaS Manager** only; all portfolio data
stays in this local environment.

> **If you are an AI agent:** follow [`AGENTS.md`](AGENTS.md).

## Installation
1. Download the latest release zip (`aws-marketplace-1password-saas-manager-<version>.zip`) from this
   repository's **Releases** page (https://github.com/1Password/aws-marketplace-1password-saas-manager/releases), and unzip it. Or clone the
   repository.
2. Install **Node.js 20 or newer** (`node --version`). Nothing else is required.
3. Open the folder in your coding agent: **Claude Code**, **OpenAI Codex**, **Gemini CLI** or **Cursor**.

## Quickstart
1. In your agent, type **`/aws-marketplace-1password-saas-manager`** (Codex:
   `$aws-marketplace-1password-saas-manager`).
2. The skill sets the project up with you: it installs dependencies, walks you through creating a
   read-only SaaS Manager API client and storing it with `npm run login` in your own terminal, and asks
   whether you want to connect an AWS profile (optional).
3. It pulls your portfolio, matches it to AWS Marketplace and opens the **AWS Marketplace Consolidation
   Insights** dashboard. Then it walks you through confirming products and requesting renewals.

## Documentation
- **This README:** [before you start](#before-you-start), [Gemini CLI setup](#set-up-gemini-cli), [setup](#setup-one-time-in-order),
  [Windows setup](#setup-on-windows), [running it](#run-it-the-guided-agent--recommended) and
  [troubleshooting](#troubleshooting).
- **Setup guide on the 1Password support site:** **REPLACE-WITH-SUPPORT-DOC-URL**
- [`CHANGELOG.md`](CHANGELOG.md): what changed in each release.
- [`AGENTS.md`](AGENTS.md): the rules every AI agent follows in this folder.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): set up, test and submit changes.
- [`SECURITY.md`](SECURITY.md): report a vulnerability privately, and which versions get fixes.

## Versioning
Releases follow [Semantic Versioning](https://semver.org/). **This project is pre-1.0:** a minor
release (for example 0.6 → 0.7) can include breaking changes, and a patch release (0.6.0 → 0.6.1)
never does. Breaking changes are marked **Breaking:** in [`CHANGELOG.md`](CHANGELOG.md), with what to
do instead. What counts as the public interface: the skill's command, the tools and their arguments,
the `npm run` commands, settings in `.env`, files in `config/`, and the fields in `report.json`.
1.0 will follow once these are stable.

## Updating
Download the latest release and unzip it into a new folder (or `git pull` in your clone). Your SaaS
Manager credentials are stored per user, so they carry over. Copy these from your old folder into the
new one: `out/` (your product picks, *Already on Marketplace* marks, shadow-IT decisions and leads) and
your `.env` settings, such as `AWS_PROFILE`. Read the [changelog](CHANGELOG.md) for anything marked
**Breaking:**. Only the latest release gets security fixes ([`SECURITY.md`](SECURITY.md)).

## Before you start
Do these before a first run (or before a call where you'll run it together). They're the steps that
took longest in early customer sessions.

1. **An AI coding agent, signed in, that can work on files on your computer.**
   - **Claude:** the **Claude desktop app**, **Code** tab (or the `claude` command-line tool). Claude Code
     must be enabled for your seat; on Team and Enterprise plans an admin may need to turn it on, after
     which you sign out and back in. Choose a **Local** session and select this folder. Claude Code on the
     web (claude.ai/code) runs in the cloud, can't see a folder on your computer, and asks you to connect
     GitHub: don't use it for this.
   - **ChatGPT:** use **OpenAI Codex** (the Codex app or CLI), not the ChatGPT chat window.
   - **Gemini:** use **Gemini CLI** (or Gemini Code Assist agent mode in VS Code or JetBrains), not the
     Gemini web or desktop chat app. Sign in with a **Gemini Code Assist for business** or **Vertex AI**
     account so your company's data terms apply: your portfolio data (application names, ACV, contract
     line items) is sent to the model you use. See [Set up Gemini CLI](#set-up-gemini-cli).
   - **Cursor:** use the Cursor app's **Agent** chat with this folder open.
   - Chat-only apps (the Gemini, ChatGPT or Claude chat windows) can't run this: the agent has to run
     commands in this folder on your computer.
2. **Unzip the bundle** (macOS: double-click; Windows: right-click › **Extract All**) and open the
   extracted `aws-marketplace-1password-saas-manager` folder in the agent, not the `.zip`.
3. **Node.js 20+ installed** (the LTS version from nodejs.org). It's the only thing to install: no
   Python and no AWS CLI. On company-managed laptops it may need IT or admin approval (for example
   *Admin By Request*).
4. **A SaaS Manager admin login**, to create a read-only API client (step 4). Save its secret in
   1Password. If you use 1Password, the tool can read the credentials from there instead of the macOS
   keychain (step 4.2).

Then type `/aws-marketplace-1password-saas-manager` in the agent's chat. It checks all of this and walks you through the rest.

## Set up Gemini CLI
Skip this if you use Claude Code, OpenAI Codex or Cursor. These steps follow Google's
[Gemini CLI documentation](https://geminicli.com/docs/); check there if anything has changed.

Gemini CLI is for organizations with **Gemini Code Assist Standard or Enterprise**, and for **Vertex AI**
on Google Cloud. Use one of those, so your company's data terms apply to the portfolio data the agent
sends to the model. Ask your Google Cloud administrator which one your company uses, and for the
**Google Cloud project ID** to sign in with.

1. **Install Gemini CLI.** It needs Node.js 20 or newer, which this bundle needs too.
   - **macOS:** `brew install gemini-cli`, or `npm install -g @google/gemini-cli`
   - **Windows (PowerShell):** `npm install -g @google/gemini-cli`
2. **Open a terminal in this folder.** Gemini CLI works in the folder you start it from.
   ```
   cd ~/Downloads/aws-marketplace-1password-saas-manager
   ```
   On Windows: `cd "$env:USERPROFILE\Downloads\aws-marketplace-1password-saas-manager"`.
3. **Sign in.** In the same terminal, set your project ID, start `gemini`, and choose the sign-in method
   when it asks:
   - **Gemini Code Assist Standard or Enterprise:** choose **Sign in with Google**, with your work account.
     ```
     export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"
     gemini
     ```
   - **Vertex AI:** sign in with the Google Cloud CLI first, then choose **Vertex AI**.
     ```
     export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"
     export GOOGLE_CLOUD_LOCATION="YOUR_REGION"
     gcloud auth application-default login
     gemini
     ```
   On Windows, set each variable with `$env:GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"` instead of
   `export`. To change the sign-in method later, type `/auth` in Gemini CLI.
4. **Trust this folder.** If Gemini CLI asks whether to trust the folder, choose **Trust folder**. In a
   folder you haven't trusted, Gemini CLI doesn't load this project's settings or its
   `/aws-marketplace-1password-saas-manager` command. Those settings are what turn off web tools and
   limit the agent to the commands the skill runs (`.gemini/settings.json`). To change your choice later,
   type `/permissions`.
5. **Start the skill.** Type `/aws-marketplace-1password-saas-manager`, and approve when Gemini CLI asks
   to use the skill. If the command isn't found, type `/skills list` to check that
   `aws-marketplace-1password-saas-manager` is listed, and `/commands reload` to load the command again.

These steps are for Gemini CLI. Setting up Gemini Code Assist agent mode in VS Code or JetBrains isn't
covered here.

## Prerequisites
- **Node.js 20 or newer** (`node --version`).
- **An AWS account is optional.** The bundle ships no AWS key. Product matching works two ways:
  - **Recommended: your own read-only AWS profile** (an access key or AWS SSO, region `us-east-1`).
    The bundle then uses the AWS Marketplace **Discovery API** for the most complete matching (every
    listing each vendor has), and the **Agreement API** to find what you already buy on Marketplace
    (step 5).
  - **Without one:** the bundle uses the public **AWS Marketplace MCP**, which needs no AWS account.
    Matching is nearly as good (on a real 315-application portfolio it agreed on 99% of ACV), but can
    miss some listings from very large sellers, and you tell the agent what you already buy on
    Marketplace.
- **No AWS CLI** to run the bundle: it calls AWS through the AWS SDK for JavaScript, which `npm install`
  installs. You only need the AWS CLI to create the optional AWS profile.
- **Access to 1Password SaaS Manager admin settings**, to create a read-only API client (step 4).

## Setup (one-time, in order)

### 1. Open a terminal in this folder
Every command below runs from the project folder. If you see
`npm error enoent Could not read package.json`, you're in the wrong folder (often your home folder, `~`).
```
cd ~/Downloads/aws-marketplace-1password-saas-manager
```
(If you received a `.zip`, unzip it first; it contains this folder. Adjust the path if you put it
somewhere else.)

### 2. Install dependencies
```
npm install
```

### 3. Create your `.env`
```
cp .env.example .env
```
You fill in one value in step 6, and only if you need it. Leave `MARKETPLACE_AWS_REGION=us-east-1`
and `MARKETPLACE_MCP_URL` as provided.

If you'll keep `.env` in a 1Password Environment (option B in step 4), skip this step: 1Password
creates the file.

### 4. Connect 1Password SaaS Manager
This bundle reads the SaaS portfolio through the **1Password SaaS Manager API**, using an API client
you create in SaaS Manager. The client secret never goes into the agent's chat: you give it to the
tool in one of three ways (4.2).

#### 4.1 Create an API client in SaaS Manager
In SaaS Manager, go to **Settings › API Access › New**. Choose OAuth 2.0 configuration
**Client credentials** and tick exactly these scopes:
**Read apps** (`Apps.Read`), **Read app accounts** (`Apps.Users.Read`), **Read contracts** (`Contracts.Read`).
Copy the **Client ID** and the **client secret**. The secret is shown only once, so save both in
1Password straight away (you need them there for options B and C). If SaaS Manager asks for an image
for the client, any small image works.

#### 4.2 Give the tool the credentials (pick one)

| | Where the credentials live | What you need | Best for |
|---|---|---|---|
| **A. Keychain** (default) | macOS keychain (Windows: a file encrypted to your Windows account) | Nothing extra | Everyone; the agent walks you through it |
| **B. 1Password Environment** | 1Password; it serves `.env` to the tool | 1Password app, macOS or Linux | 1Password users on a Mac: no Terminal step |
| **C. 1Password CLI** | 1Password; `.env` holds references to them | 1Password app + 1Password CLI | 1Password users on Windows, or anyone already using the CLI |

If more than one is set up, B or C (anything in `.env`) wins over A. `npm run status` shows which one
is in use on its `Source:` line.

**A. Keychain.** Run this in your own terminal (macOS Terminal, or the Terminal panel in Claude),
**not** the `!` prompt inside a Claude chat. The secret prompt needs to read your keyboard, and running
it yourself keeps the secret out of the conversation.
```
npm run login -- --host trelica.app --client-id YOUR_CLIENT_ID
```
- Replace `YOUR_CLIENT_ID` with your actual Client ID. Don't wrap it in `< >`: zsh treats `<` and `>`
  as redirection and fails with `parse error near '\n'`.
- Keep `--client-id ` (with the space) in front of the ID.
- Use `--host trelica.eu` for EU tenants.
- At `Client secret:`, paste the secret and press Enter. Nothing is echoed; that's expected.

The last line should start with `Credentials stored in`. The credentials are only saved after SaaS
Manager accepts them. To remove them later: `npm run logout`.

**B. 1Password Environment** (macOS and Linux). 1Password serves `.env` straight from an
**Environment**, so the settings and the credentials stay in 1Password and nothing is copied to the
keychain or written to disk. No 1Password CLI needed.
1. In the 1Password app, go to **Developer › Environments** and create an Environment (for example
   *Consolidation agent*). If you don't see Environments, turn it on in the app's **Developer**
   settings, or ask your 1Password administrator.
2. Add these variables (the rest of `.env.example` has working defaults, so add others only if you
   need to change them):
   ```
   SAAS_PROVIDER=1password
   ONEPASSWORD_SM_HOST=trelica.app
   ONEPASSWORD_SM_CLIENT_ID=<your Client ID>
   ONEPASSWORD_SM_CLIENT_SECRET=<your client secret>
   MARKETPLACE_AWS_REGION=us-east-1
   MARKETPLACE_MCP_URL=https://marketplace-mcp.us-east-1.api.aws/mcp
   ```
   Use `trelica.eu` for EU tenants. Add `AWS_PROFILE` only if step 6 says you need it.
3. Under the Environment's **Destinations**, choose **Local .env file** and pick this folder, so the
   file is `.env` here. If a `.env` is already there (for example from step 3), delete it first.

Keep 1Password unlocked while the agent runs. 1Password may ask you to approve when the tool reads
`.env`, and the command waits until you do. To change a setting later, edit the Environment in
1Password: the agent won't edit or read this `.env`.

**C. 1Password CLI (secret references).** Any OS. Your `.env` stays a normal file, but holds
*references* to the credentials instead of the credentials themselves. When the tool connects, it reads
each one with `op read`; the values are never written to disk or shown to the agent.
1. Install the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and, in the
   1Password app, turn on **Settings › Developer › Integrate with 1Password CLI**.
2. In `.env`, in the `1Password SaaS Manager connection` section, fill in the three lines with
   references to the item you saved in 4.1, **and delete the `#` at the start of each one**:
   ```
   ONEPASSWORD_SM_HOST=trelica.app
   ONEPASSWORD_SM_CLIENT_ID=op://Private/SaaS Manager API/username
   ONEPASSWORD_SM_CLIENT_SECRET=op://Private/SaaS Manager API/credential
   ```
   Use your own vault, item and field names. To get a reference, open the item in 1Password, click
   the field's down arrow and choose **Copy Secret Reference**.

1Password asks you to approve (for example with Touch ID) when the tool first reads them, and again
from time to time.

#### 4.3 Check it worked
```
npm run status
```
It should show where the credentials came from (`Source:`) and end with
`API: ok (GET /api/apps/v1 -> 200)`. If it says no credentials were found, the message names the
likeliest fix for the option you chose.

### 5. (Optional, recommended) Your own AWS profile
A read-only AWS profile from your own AWS account gives the most complete matching (the Discovery API)
and finds the applications you already buy through AWS Marketplace (the Agreement API). **You can skip
this step:** without a profile, the bundle matches against the public AWS Marketplace MCP, which needs no
AWS account, and you tell the agent what you already buy. You can add a profile later.

The profile needs the read-only permissions in [`config/discovery-iam-policy.json`](config/discovery-iam-policy.json):
`SearchListings`, `GetListing` and `GetProduct` for matching, plus `SearchAgreements` and
`DescribeAgreement` for the *Already on AWS Marketplace* view. Ask your AWS administrator to attach that
policy: it's the least access the bundle needs. (The AWS-managed `AWSMarketplaceRead-only` policy also
works, but allows more reads than the bundle uses.)

1. Install the AWS CLI:
   ```
   brew install awscli
   ```
2. Create a named profile with those read-only AWS Marketplace permissions. This guide uses
   the profile name `marketplace-readonly`; you can choose another, then use it everywhere below.
   ```
   aws configure --profile marketplace-readonly
   ```
   If your company signs in to AWS through SSO, use `aws configure sso --profile marketplace-readonly` instead.
   If you were given **temporary credentials** (an access key, secret key *and* session token), see
   **Temporary AWS credentials** below.

   Answer the prompts like this, in your own terminal (never paste AWS keys into a chat):

   | Prompt | Answer |
   |---|---|
   | `AWS Access Key ID` | your access key ID |
   | `AWS Secret Access Key` | your secret access key |
   | `Default region name` | `us-east-1` |
   | `Default output format` | `json` |
   | `Configure AWS skills and the AWS MCP server for your AI coding agent(s)? [y/n/never]` | `n` (or `never` to stop being asked) |

   About the last two:
   - **Output format `json`:** the bundle calls AWS through the AWS SDK, so this only keeps your own
     manual checks with the AWS CLI readable.
   - **AWS skills / AWS MCP server: `n`:** this agent calls AWS directly. It doesn't use AWS's
     MCP server or skills, and saying yes would add AWS's tools to your AI coding agent's configuration,
     which this setup doesn't need.
3. Verify the profile:
   ```
   aws sts get-caller-identity --profile marketplace-readonly
   ```
   It should print your AWS account and ARN as JSON.

#### Temporary AWS credentials
Some AWS access (e.g. federated sign-in) hands out temporary
credentials that include a session token and expire after about an hour. Save all three into the profile:
```
aws configure set aws_access_key_id YOUR_ACCESS_KEY_ID --profile marketplace-readonly
aws configure set aws_secret_access_key YOUR_SECRET_ACCESS_KEY --profile marketplace-readonly
aws configure set aws_session_token YOUR_SESSION_TOKEN --profile marketplace-readonly
aws configure set region us-east-1 --profile marketplace-readonly
```
When they expire, the next run falls back to the AWS Marketplace MCP and says why. Get fresh credentials
and run these again.

### 6. Fill in `.env`
Edit `.env` and set:
- `AWS_PROFILE=marketplace-readonly` (the profile name from step 5). Leave it empty if you skipped
  step 5: the bundle then uses the AWS Marketplace MCP.

Check which one the next run will use with `npm run detect`: *AWS Marketplace Discovery API* shows as
connected when your profile works. If your profile is set but can't be used (a missing permission, an
expired SSO sign-in), the run uses the MCP and the report says why.

### 7. (Optional) The MCP server
The skill doesn't need it: it calls the same tools through `npm run -s tool`. The included
`.mcp.json` also registers them as the **consolidation-agent** MCP server, for MCP clients such as
Claude Desktop. The server only connects if steps 2–3 are done (it needs `node_modules/` and `.env`);
if it shows as failed to connect, restart the session after finishing setup.

## Setup on Windows
Tested on Windows 11 with Node.js v24. Run these in **PowerShell** (Start menu ›
PowerShell). Windows PowerShell 5 doesn't support `&&`; run commands one at a time or join them with `;`.

### W1. Check prerequisites
```powershell
node --version    # 20+
```
- **Node.js missing:** install the LTS version from nodejs.org, then reopen PowerShell (and your AI
  agent app) so the new `PATH` applies. On company-managed laptops this may need admin approval (for
  example *Admin By Request*).
- Nothing else is needed: no Python and no AWS CLI.

### W2. Open the project folder and install dependencies
```powershell
cd "$env:USERPROFILE\Downloads\aws-marketplace-1password-saas-manager"
npm install
```
(Adjust the path to wherever you put the folder. If you received a `.zip`, extract it first
(right-click › Extract All, or `Expand-Archive <file>.zip`) and `cd` into the extracted folder.)

### W3. Create `.env` and connect SaaS Manager
```powershell
copy .env.example .env
```
Then store the SaaS Manager API client credentials (create the client as in step 4.1) the same way as on
a Mac, in your own PowerShell window:
```powershell
npm run login -- --host trelica.app --client-id YOUR_CLIENT_ID
```
Paste the secret at `Client secret:` (Ctrl+V or right-click) and press Enter. It's saved encrypted to
your Windows account (DPAPI, under `%APPDATA%\consolidation-agent-1password\`), so only you, on this
PC, can read it. The last line should start with `Credentials stored in`.

Verify: `npm run status` should end with `API: ok (GET /api/apps/v1 -> 200)`.

**If you use 1Password,** you can skip `npm run login` and use option C in step 4.2 (the 1Password
CLI) instead: `.env` then holds references to the credentials rather than the credentials themselves.
1Password Environments (option B) can't serve `.env` on Windows.

**If `npm run login` fails with a PowerShell error** (for example PowerShell is blocked by policy), use
option C: keep the credentials in 1Password and put secret references in `.env`. The client secret is
never stored in `.env` as plain text: the tool refuses a plain-text secret there and explains what to
do instead.

### W4. (Optional, recommended) Your own AWS profile
Optional, as in step 5: without a profile the bundle uses the public AWS Marketplace MCP. With one, you
get the most complete matching and the *Already on AWS Marketplace* view (install the AWS CLI with
`winget install Amazon.AWSCLI`, create the profile, then set `AWS_PROFILE` in `.env`).

Use step 5 above (`aws configure --profile default`, region `us-east-1`, output `json`, answer `n` to
the AWS skills prompt). For temporary credentials pasted into PowerShell as environment variables, save
them into the profile:
```powershell
aws configure set aws_access_key_id $env:AWS_ACCESS_KEY_ID --profile default
aws configure set aws_secret_access_key $env:AWS_SECRET_ACCESS_KEY --profile default
aws configure set aws_session_token $env:AWS_SESSION_TOKEN --profile default
aws configure set region us-east-1 --profile default
```
Temporary credentials expire after about an hour. If stale ones get stuck in the session, clear them:
`Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue`

Verify: `aws sts get-caller-identity --profile default`.

### W5. Run
Start the skill (see *Run it (the guided agent)*), or run the pipeline directly:
```powershell
npm run pipeline
start out\1password\CONSOLIDATION-REPORT.html
```

### Windows gotchas
| Issue | Cause | Fix |
| --- | --- | --- |
| `npm run status` says the `ONEPASSWORD_SM_` lines "still start with `#`" | Secret references filled in `.env` but left commented out | Delete the `#` at the start of all three lines and save (option C) |
| `npm run status` says "a plain-text secret, which isn't supported" | The client secret was typed into `.env` | Delete that line; use `npm run login`, or option C (W3) |
| `npm run login` → `Could not run PowerShell` / `Saving the credentials failed` | PowerShell blocked by policy | Use option C, 1Password secret references (W3) |
| A Renew email button does nothing | No desktop app is set to open email links, or the mailbox isn't the web app chosen | Click **Use another email app** in the note that appears, and pick **Gmail** for a Google mailbox (even one read in desktop Outlook), or **Copy the email instead** |

## How matching reaches AWS Marketplace
The bundle ships **no AWS credentials**. `src/catalog.ts` picks the catalog source once per run:

1. **The customer's own AWS profile** (`AWS_PROFILE` in `.env`), if set and a one-listing test search
   with it succeeds: the Discovery API for matching and Deployed-on-AWS badges, and the Agreement API
   for purchases. The bundle never uses AWS credentials the customer didn't name: no default profile, no
   ambient environment keys.
2. **Otherwise, the public AWS Marketplace MCP** (`src/discoveryMcp.ts`): search hits grouped by vendor
   name, with `deployed_on_aws` from the hit.

`run_consolidation` passes the choice to every step (`CATALOG_SOURCE`), saves it in
`out/<provider>/catalog-source.json`, and the dashboard and the tool's result say which source was used
and why.

**MCP shape checks.** The MCP is a public service the bundle doesn't control. Every response from the
three tools the bundle uses is checked in `src/mcpShapes.ts`: listings without a valid id are dropped,
wrongly typed fields are removed (so the dashboard shows "–" rather than "undefined"), and every problem
is counted in `out/<provider>/mcp-health.json`. The report then:
- shows a notice at the top of the dashboard when anything was dropped or changed;
- runs a render check on the finished page (`src/renderCheck.ts`: no "undefined", "NaN" or
  "[object Object]", every ACV numeric, every tab present) and shows a notice if it fails;
- puts both results in `report.json` (`checks`), so the agent tells the user.

Run `npm run check-mcp` to check the live MCP against what the bundle expects (plus offline tests of the
checks themselves). It exits non-zero on any change, so it suits a scheduled CI job. `check_setup` also
runs a quick version.

**Upgrading from 0.5.x:** if your folder has `config/discovery-credentials.json`, delete it. It's no
longer used.

## Run it (the guided agent — recommended)
Open this folder in your coding agent and start the **aws-marketplace-1password-saas-manager** skill (1Password SaaS Manager's AWS Marketplace Skill):

| Agent | How to start it |
|---|---|
| **Claude Code** (CLI, or the Code tab in Claude Desktop) | `/aws-marketplace-1password-saas-manager`, or ask "run the consolidation agent" |
| **OpenAI Codex** (CLI or IDE extension) | `$aws-marketplace-1password-saas-manager` (or pick it from `/skills`), or ask "run the consolidation agent" |
| **Gemini CLI** (or Gemini Code Assist agent mode) | `/aws-marketplace-1password-saas-manager`, or ask "run the consolidation agent" |
| **Cursor** (Agent chat) | `/aws-marketplace-1password-saas-manager`, or ask "run the consolidation agent" |

On first use the skill sets the project up with you (dependencies, `.env`, the SaaS Manager API
client) and asks whether you can connect your own AWS profile (optional). It runs everything it can
itself and gives you the commands that need a secret to run in your own terminal. It then checks
setup: 1Password SaaS Manager and the AWS Marketplace MCP must show as connected; AWS Marketplace
Discovery shows as connected only if you set up an AWS profile. Then it will:
1. pull the 1Password SaaS Manager portfolio and match it to AWS Marketplace,
2. show the ranked consolidation report,
3. ask the user to confirm any uncertain product matches,
4. capture a renewal lead for the AWS customer-advisor team ("Renew on Marketplace"),
5. surface comparable AWS Marketplace solutions,

and open the dashboard (`out/1password/CONSOLIDATION-REPORT.html`) in your browser.

Customers run it themselves, on their own computer. For help, they contact their 1Password account team. ChatGPT's and Gemini's chat apps
can't run local tools, so ChatGPT users run the skill in **Codex**, and Gemini users in **Gemini CLI**.

**What the agent is allowed to do.** The project ships settings that keep the agent to this job:
- **Claude Code** (`.claude/settings.json`): no web fetching or web search; common network and
  secret-reading commands (`curl`, `ssh`, `aws`, `op`, `security`, `printenv` and similar) are blocked;
  and the agent can't read or edit `.env` or your AWS credential files (`~/.aws/`).
- **Gemini CLI** (`.gemini/settings.json`, `.geminiignore`): no web tools; shell commands are limited to
  the ones the skill runs (`npm`, `node --version`, copying `.env`, opening the dashboard); and its file
  tools skip `.env`.
- **Cursor** (`.cursorignore`): the agent can't read `.env`. Also
  review its agent permissions (for example, ask before running commands) in Cursor's settings.
- **Codex:** no project settings ship for Codex; it follows the same rules from `AGENTS.md` and the skill.

The skill and `AGENTS.md` also tell every agent never to read or edit those two files, and to pass
tool arguments in a file rather than on the command line. A deny rule is stronger than an instruction,
but neither covers every possible command, so keep your agent asking before it runs commands.

These are a second layer: whatever the agent's settings say, the bundle itself only connects to
SaaS Manager and AWS Marketplace (`src/egress.ts`), plus, if your AWS profile uses SSO or assumes a role,
AWS's own sign-in services to get that profile's credentials. AWS endpoint overrides
(`AWS_ENDPOINT_URL*`, `endpoint_url`) are ignored, so AWS calls can't be redirected elsewhere.

**The command-line tool.** The skill calls the same tools as the MCP server, from the shell:
```
npm run -s tool -- list
npm run -s tool -- help record_product_selection
npm run -s tool -- get_consolidation_report @.cache/tool-args.json
```
Arguments go in a JSON file inside the project (here `.cache/tool-args.json`, containing
`{"provider":"1password"}`), never on the command line: they can include application and product names
from your data, and a name with a quote in it could otherwise run as a shell command. Output is JSON.

## Run it (CLI, no agent — for a quick check)
```
npm run pipeline
```
Then open `out/1password/CONSOLIDATION-REPORT.html`. Re-run any time to refresh.

**Confirming products in the report.** The **Needs confirmation** tab lists one row per
application, with a hint from its contract line items and a dropdown of the vendor's Marketplace
products: pick the one you use (or "None of these"; "View listing" opens the chosen product). A pick
isn't applied until the report is regenerated, and the bar above the table counts picks not yet applied.
The quickest way to apply them is **Copy for your agent**: paste it into the agent's chat and it records
the picks and regenerates the report. Without an agent, click **Download selections.json**, save the file as `out/1password/selections.json` (replacing any existing
one) and regenerate:
```
npm run analyze && npm run report
```
Picks from earlier rounds are kept: the download merges them with your new ones.

**Applications you already buy on AWS Marketplace.** Without the optional Agreements view, the report
can't see your AWS Marketplace purchases, so some of them may show up as opportunities. Click
**Already on Marketplace** on the application's row (in *Ready to renew* or *Needs confirmation*): it
moves straight to the **Already bought** tab and every total on the page updates. To keep the mark,
click **Copy for your agent** and paste it into the agent's chat, or just tell the agent ("we already
buy Snowflake through AWS Marketplace"); until then it lasts only until you reload the page. Marks are kept in `out/1password/already-on-marketplace.json`; **Not on
Marketplace? Undo** in that section takes one back. Without an agent:
the `record_already_on_marketplace` tool with `{"provider":"1password","app":"Snowflake"}`.

**Printing the renewal list.** The *Ready to renew* tab has a **Print to PDF** button. It prints
just that list (the header, the summary line and every renewal group, expanded) without the on-screen
buttons; choose **Save as PDF** in the print dialog to get a file to share.

**Lead email buttons.** In the HTML report, **Renew on Marketplace** and **Get in touch** open a
pre-filled email. The first click asks which email app to use (Gmail, Outlook on the web for work or
school accounts, Outlook.com, or the desktop email app) and remembers the choice in that browser. Gmail
and Outlook open a compose window in the browser, so this works without a desktop mail app. Pick
**Gmail** for any Google mailbox, including one read in desktop Outlook. After each click a note says
where the email opened, with **Use another email app** in case nothing opened; the menu also has
**Copy the email instead**. "Change" under the Ready to renew heading resets the choice. The Markdown report and `report.json` keep plain `mailto:` links.

**Report name.** The report's brand line and title come from `productName` and `reportName` in
`config/bundle.json` (currently "1Password SaaS Manager" / "AWS Marketplace Consolidation Insights"); change
them there before packaging. The output file is still `CONSOLIDATION-REPORT.html`.

**Where leads go.** Every renewal and new-purchase lead (the report's **Renew on Marketplace** /
**Get in touch** buttons and the skill's lead tools) is addressed to `leadRecipient` in
`config/bundle.json` — **1Password-SM-AWS-Marketplace@amazon.com**. It's fixed for everyone who
receives the bundle, so customers aren't asked for it, and a `LEAD_RECIPIENT` in a customer's `.env`
is ignored. If the config file is missing, the same alias is the built-in default (`src/lead.ts`). 

**Marketplace link attribution.** Every AWS Marketplace link in the report, leads and agent replies
is tagged `ref_=SaaS_Manager_1Password&src=consolidation_agent` (replacing the Marketplace MCP's own
tracking tags). Override with `MARKETPLACE_URL_REF` / `MARKETPLACE_URL_SRC` in `.env`.

## Troubleshooting
- **`npm error enoent Could not read package.json`** — the terminal isn't in the project folder; see step 1.
- **`zsh: parse error near '\n'`** — a `<placeholder>` was left in a command; replace it, brackets included (step 4).
- **`node: .env: not found`** when running `npm run tool` — `.env` doesn't exist yet; do step 3.
- **consolidation-agent MCP server "failed to connect" / "Connection closed"** — only matters if you use the optional MCP
  server (step 7). Setup isn't finished (no `node_modules/` or `.env`), or the session started before it was; finish steps 2–3
  and restart the session. The skill doesn't need the server.
- **`No report yet` / `ENOENT ... report.json`** — run the pipeline first (`npm run pipeline`,
  or the agent's `run_consolidation` tool); the report is generated, not shipped.
- **`No SaaS Manager credentials found`** — set the credentials up with one of the options in step 4.2; the message names the likeliest fix.
- **A command hangs with no output while `.env` is a 1Password Environment** — 1Password is locked or waiting for you to approve the read. Unlock it or approve, and the command continues.
- **Empty portfolio / auth error from the 1Password SaaS Manager source** — recheck step 4 (`npm run status` must return API ok).
- **`GET /api/apps/v1/<id>/users -> 403`** — the API client is missing the **Read app accounts** (`Apps.Users.Read`)
  scope; the report still runs but without usage (adoption) data.
- **`command not found: aws`** — the bundle doesn't need the AWS CLI; you only need it to create the optional
  AWS profile (step 5).
- **`InvalidClientTokenId` from `aws sts get-caller-identity`** — the profile holds something other than AWS keys
  (e.g. the SaaS Manager Client ID was pasted in). AWS access key IDs are 20 characters, starting `AKIA` (or `ASIA`
  for temporary keys). Re-run `aws configure --profile <name>` with your AWS credentials.
- **The report says it "Matched using the public AWS Marketplace MCP" although you set `AWS_PROFILE`** — your
  profile couldn't use the Discovery API; the run's result and `npm run detect` say why (often an expired SSO
  sign-in or temporary credentials, or a missing permission from `config/discovery-iam-policy.json`). Fix it and
  run again; until then the MCP is used.
- **A notice at the top of the dashboard says AWS Marketplace details "came back in an unexpected format"** — the
  AWS Marketplace MCP changed how it returns data. Affected listings or details are left out (your SaaS Manager
  figures aren't affected). Run `npm run check-mcp` to see what changed, and tell your 1Password account team.
- **A notice says "Parts of this dashboard may not display correctly"** — run the consolidation again; if it stays,
  tell your 1Password account team.
- **Windows-specific errors** — see *Windows gotchas*.
- **Matching returns nothing** — check that the AWS Marketplace MCP is reachable (`npm run detect`). If you use an
  AWS profile, confirm `AWS_PROFILE` in `.env` names a valid profile with read-only AWS Marketplace access in
  `us-east-1` (`aws sts get-caller-identity --profile <name>`).
- **A contract lands on the wrong application** — the agent reads each contract's *Main application* from the
  SaaS Manager API (available from the next SaaS Manager release). To override one, copy
  `config/app-attribution.example.json` to `config/app-attribution.json` and fill it in (the file explains the format).
  The run log shows `API` / `FILE` / `by-name` per contract.

## Contributing
Contributions are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md). Please report security issues privately, as described in
[`SECURITY.md`](SECURITY.md), not in a public issue.

## License
[MIT](LICENSE) © 2026 AgileBits Inc.
