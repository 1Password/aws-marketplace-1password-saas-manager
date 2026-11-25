# What's new

Releases follow [Semantic Versioning](README.md#versioning). Before 1.0, a minor release can include
breaking changes; they're marked **Breaking:**.

## 0.7.0

**Breaking:** the SaaS Manager client secret can no longer be typed into `.env` as plain text. If yours
is, `npm run status` says so: delete that line, then run `npm run login` (the macOS keychain, or on
Windows a file encrypted to your account), or keep the credentials in 1Password, either with a
1Password Environment that serves `.env` or with `op://` secret references in `.env`. If
`npm run login` fails on Windows because PowerShell is blocked, use the secret references.

- **Now open source under the [MIT license](LICENSE).** New `CONTRIBUTING.md` (how to set up, test and
  submit changes), `CODE_OF_CONDUCT.md` (the Contributor Covenant), `SECURITY.md` (how to report a
  vulnerability privately, and which versions get fixes), and GitHub issue and pull request templates.
  The README starts with installation, a quickstart and links to the documentation, and explains
  versioning and how to update.
- **`npm run detect` and `check_setup` show the skill's name** in their connection summary.
- **The skill no longer suggests specific applications** when it asks what you already buy on AWS
  Marketplace. It names two or three of your own largest applications instead.

## 0.6.0

**Breaking:** the bundled AWS key and the `DISCOVERY_AUTH` setting are gone. Matching uses your own
AWS profile (`AWS_PROFILE`) if you set one, otherwise the public AWS Marketplace MCP. If you set
`DISCOVERY_AUTH`, remove it from `.env`.

**No AWS key in the bundle**
- **The bundle no longer includes an AWS key, so it can be published,** for example on GitHub.
- **During setup, the skill asks whether you can connect a read-only AWS profile from your own AWS
  account.** If you can, matching uses the AWS Marketplace Discovery API with that profile: every
  listing each vendor has, plus the *Already on AWS Marketplace* view. It's optional.
- **Without a profile, matching uses the public AWS Marketplace MCP,** which needs no AWS account. In
  testing it agreed with the Discovery API on 99% of ACV. It can miss some
  listings from very large sellers, and the skill asks you what you already buy on Marketplace.
- **If your profile is set but can't be used** (a missing permission, an expired SSO sign-in), the run
  uses the MCP and tells you why. The bundle never uses AWS credentials you didn't name in `.env`.
- **The permissions a profile needs are in `config/discovery-iam-policy.json`:** three catalog reads
  for matching, plus two agreement reads for the *Already on AWS Marketplace* view.
- **Upgrading from 0.5.x:** if your folder has `config/discovery-credentials.json`, delete it. It's no
  longer used.
- **The dashboard invites you to connect your AWS profile** to see what you already buy on AWS
  Marketplace, instead of warning that Agreements isn't connected. The wording depends on whether you
  have no profile yet or your profile lacks the two agreement permissions. During setup, the skill
  now mentions those permissions if your profile works for matching but can't read your purchases.

**Checks on AWS Marketplace data and the dashboard**
- **Every AWS Marketplace MCP response is checked.** Listings without a valid id are left out, and
  fields of the wrong type are removed, so the dashboard shows "–" rather than "undefined".
- **The dashboard shows a notice if anything was affected,** saying what changed and that your SaaS
  Manager figures (ACV, Accounts, renewal dates) aren't.
- **The dashboard checks itself after it's built:** no "undefined", "NaN" or "[object Object]", every
  ACV is a number, and every tab is present. If anything fails, it shows a notice.
- **The agent hears about both.** `run_consolidation` and the report return `checks`, and the skill
  tells you if either check failed.
- **New `npm run check-mcp`** checks the live MCP against what the dashboard needs, and tests the
  checks themselves. `check_setup` runs a quick version.

**Security**
- **AWS endpoint overrides are ignored everywhere,** including the AWS sign-in calls an SSO or
  assume-role profile makes. Before, they were ignored only for the Marketplace calls themselves.
- **The bundle never falls back to your `default` AWS profile.** Only the profile named in
  `AWS_PROFILE` is used: before, the Agreements setup check tried `default` when none was set.
- **Setup errors are fixed text too:** `npm run status` and `npm run check-mcp` no longer show raw
  error messages.

**Fixes**
- **Catalog data is refreshed weekly.** Cached AWS Marketplace responses used to be reused forever,
  so listings added after your first run never appeared. They now expire after 7 days.
- **AWS calls retry when AWS Marketplace throttles them,** instead of failing the run.

## 0.5.6

**Breaking:** tool arguments are now type-checked, so a call that passed a number as text (for
example `"max": "50"`) is rejected; pass `"max": 50`. An `@file` argument must be a `.json` file
inside the project folder.

**Security fixes**
- **The agent can't read or edit `.env` or the bundled AWS key file.** Claude Code blocks it
  (`.claude/settings.json`), Gemini CLI and Cursor skip both files (`.geminiignore`, `.cursorignore`),
  and the skill and `AGENTS.md` tell every agent never to read them. The skill no longer edits `.env`
  to set `AWS_PROFILE`: it tells you the line to change, and you change it.
- **Tool arguments go in a file, not on the command line.** The agent writes them to
  `.cache/tool-args.json` and runs `npm run -s tool -- <tool> @.cache/tool-args.json`. Application and
  product names from SaaS Manager or AWS Marketplace can no longer break out of the command's quoting
  and run as shell commands. An arguments file must be a `.json` file in the project folder, so `.env`
  and credential files can't be passed.
- **Every tool argument is type-checked** by both the command-line tool and the MCP server. For
  example, `max` must be a whole number of 1 or more.
- **The analysis no longer runs through a shell.** Each step runs Node directly instead of through
  `npm` (which needs a shell on Windows), so no argument can be interpreted as a command.

**Hardening**
- **AWS calls ignore endpoint overrides.** `AWS_ENDPOINT_URL*` settings in `.env` or `~/.aws/config`
  can no longer redirect AWS Marketplace requests to another host.
- **No more AWS CLI.** The *Already on AWS Marketplace* view now reads your agreements through the
  AWS SDK, like the rest of the bundle. It still uses your own AWS profile, but you no longer need the
  AWS CLI installed for it.
- **Names written into the dashboard are cleaned** of hidden characters, so text you copy back to
  the agent with *Copy for your agent* can't carry hidden instructions. The skill also treats that
  pasted text as data.
- **Error messages are fixed text.** AWS, SaaS Manager and AWS Marketplace MCP errors are reported by
  their error type and HTTP status, never by the raw response, and invalid JSON is reported as
  "invalid JSON" without quoting the file. Credentials or file contents can't end up in the agent's
  conversation through an error.

**Agent instructions**
- **New `AGENTS.md`** holds the instructions for every agent; `CLAUDE.md` and `GEMINI.md` point to it,
  and the README's agent notes now just link to it.

## 0.5.5

**Breaking:** the zip and folder have a new name (below).

- **The zip and folder are now named `aws-marketplace-1password-saas-manager`**, to match the command
  and branding (they were `consolidation-agent-1password`). If you already ran `npm run login`, you
  don't need to again: your saved credentials are kept.
- **The skill is now called *1Password SaaS Manager's AWS Marketplace Skill*** in the README, the skill
  itself and the agent instructions. The command (`/aws-marketplace-1password-saas-manager`) and the
  dashboard name (*AWS Marketplace Consolidation Insights*) are unchanged.

## 0.5.4

**Breaking:** the command was renamed. Use `/aws-marketplace-1password-saas-manager`.

**New names**
- **The command is now `/aws-marketplace-1password-saas-manager`** (Codex:
  `$aws-marketplace-1password-saas-manager`). It was `/aws-marketplace-saas-manager` in 0.5.3.
- **The dashboard is now called *AWS Marketplace Consolidation Insights*,** to make clear which
  marketplace it covers.

**Cursor**
- **Run the agent in Cursor's Agent chat** with `/aws-marketplace-1password-saas-manager`. The skill
  is in `.cursor/skills/`.

## 0.5.3

**Breaking:** the command was renamed from `/consolidation-agent`.

**New name: `/aws-marketplace-saas-manager`**
- **The skill is now called AWS Marketplace × 1Password SaaS Manager.** Start it with `/aws-marketplace-saas-manager` in
  Claude Code and Gemini CLI, or `$aws-marketplace-saas-manager` in Codex (it was `/consolidation-agent`). Asking the agent to
  "run the consolidation agent" still works.

## 0.5.2

**Gemini CLI**
- **Run the agent in Gemini CLI** (or Gemini Code Assist agent mode) with `/consolidation-agent`. It
  uses the same skill as Claude Code and Codex.
- **Gemini gets the same limits as Claude:** its web tools are off, and it can only run the shell
  commands the skill needs (`.gemini/settings.json`).
- The Gemini and ChatGPT chat apps can't run the agent, because it has to run commands on your
  computer. The README says which apps to use.

**Keep `.env` in 1Password**
- **`.env` can be a 1Password Environment** (macOS and Linux). 1Password serves the file, so your
  settings and the SaaS Manager credentials stay in 1Password, and there's no `npm run login` step.
  `npm run status` shows where the credentials came from.
- **Or put 1Password secret references in `.env`** (`op://vault/item/field`, any OS). The tool reads
  them with the 1Password CLI when it connects.
- The agent never copies over, edits or reads a `.env` that 1Password serves, and Claude Code is
  blocked from commands that print secrets (`op`, `security`, `printenv`).

## 0.5.1

**Breaking:** the `get_detailed_comparison` tool was removed (below). Hosts other than SaaS Manager and
AWS Marketplace set in `.env` are now refused.

**Outbound calls only for the dashboard and emails**
- **The bundle only connects to the services the dashboard needs:** SaaS Manager (`trelica.app` or
  `trelica.eu`), the AWS Marketplace MCP, and AWS Marketplace in `us-east-1`. Any other address, any
  plain-http URL, or a different host set in `.env` is refused before connecting (`src/egress.ts`).
- **Removed the detailed product comparison** (`get_detailed_comparison`). It had AWS run web
  research and passed web pages to the agent. Comparisons now come only from the Marketplace catalog
  data on the dashboard's Compare panel.

**Prompt-injection protection**
- **Tool results are cleaned before the agent sees them.** Hidden characters that can smuggle text
  past a reader (zero-width, direction overrides, Unicode tag characters) are removed, each value is
  length-capped, and every result is labelled as data, not instructions.
- **Tools only accept your own data.** Product picks must be one of the products offered for that
  application, and only apps on your Missing a contract list can be searched on Marketplace, so the
  agent can't be steered into sending other text to AWS. The MCP server now rejects unexpected
  arguments, as the command-line tool already did.
- **The agent treats tool results as data.** The skill and the server instructions tell it never to
  act on text in tool results, and to tell you if it finds any.

**Security**
- **The dashboard can't load or send anything.** A Content-Security-Policy allows only its own inline
  styles and scripts, so even injected markup couldn't fetch, post to or load from another site.
- **Links from Marketplace data must be https.** A product link that isn't (for example
  `javascript:`) is dropped rather than shown.
- **Your report folder is private to you.** `out/` and the leads folder are now readable only by your
  user account, since they hold contract figures and lead contact details.
- **`.gitignore` covers `out/` and `.cache/`,** so your portfolio and leads can't be committed by
  accident.

## 0.5.0

**ACV fix**
- **A contract's term now comes from its own start and renewal dates** in SaaS Manager. Before, it
  was stretched to cover its line items' dates, which are sometimes copied from an older contract.
  This understated ACV: for example, a $90,000-a-year contract could show as $30,000.

**Dashboard**
- **Already on AWS Marketplace has its own tab, "Already bought".** Before, it sat at the top of
  *Ready to renew*.
- **Marking an application as already on Marketplace moves it straight away.** The row moves to
  *Already bought* and every total on the page updates: the summary tiles, tab counts, the 90-day
  renewals, the AWS commitment figure and the renewal groups. *Not on Marketplace? Undo* moves it
  back. Your agent still applies the mark (*Copy for your agent*), so it's kept when the report is
  regenerated.
- **The summary tiles always fill whole rows.** With six tiles, the last one wrapped onto its own
  row and left an empty grey space. Six tiles now show as two rows of three.

## 0.4.0

**More accurate ACV**
- **ACV now counts only current contracts.** Before, every contract an application ever had in
  SaaS Manager was added up, including expired ones, which overstated ACV several times over.
  Renewals signed early no longer count twice either.
- **Multi-year contracts are divided by their term:** for example, $300K over 18 months is $200K a
  year. Before, a contract with "Year 1" and "Year 2" lines counted each year as a full
  year.
- **One-time fees** (professional services, implementation, onboarding) are left out of ACV.
- If every contract for an application has ended, it still shows under *Renewal date has passed*,
  with its most recent contract's ACV.

## 0.3.0

**Dashboard**
- **Print to PDF** on the *Ready to renew* tab prints just that list, branded, with every renewal
  group expanded. Choose **Save as PDF** in the print dialog to share it.
- **Already on Marketplace** now sits under each row's **Renew on Marketplace** and **Compare**
  buttons, so it no longer pushes **Compare** out of view.
- Printing the whole report now always comes out in light mode, even when your screen is in dark
  mode.

## 0.2.0

**Easier setup**
- **Only Node.js is needed now.** Python and the AWS CLI are no longer required, so there's nothing
  else to install (or to ask IT to approve).
- **Windows: `npm run login` works the same as on a Mac.** Run it in PowerShell; the SaaS Manager
  secret is stored encrypted to your Windows account. No more editing `.env` by hand.
- If you do use the `.env` fallback and leave the lines commented out with `#`, `npm run status`
  now says so.
- The agent checks prerequisites up front, says how long the analysis will take on a large
  portfolio, and gives progress updates while it runs.
- New **Before you start** checklist at the top of the README.

**Dashboard**
- **Already on Marketplace:** mark applications you already buy through AWS Marketplace, on their
  row or by telling the agent. They move to *Already on AWS Marketplace* and out of the
  opportunity totals.
- **Product picks are easier to apply:** the bar counts changes not yet applied, and **Copy for
  your agent** hands them to the agent, which applies them and refreshes the report.
- **Email buttons:** clearer choices (pick **Gmail** for any Google mailbox, including one read in
  desktop Outlook), a **Copy the email instead** option, and a note after each click with
  **Use another email app** if nothing opened.

## 0.1.0
First release.
