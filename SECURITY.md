# Security policy

## Reporting a vulnerability

Please report security issues **privately**, never in a public issue, pull request or discussion.

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose
**Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do
with it. Leave out any real customer data, credentials or portfolio details.

We'll acknowledge your report, keep you updated as we investigate, and credit you in the advisory
and the changelog if you'd like.

## Supported versions

The project is pre-1.0 (see [Versioning](README.md#versioning)). Security fixes go into the **latest
release only**. Update to it to get them: your SaaS Manager credentials and your `out/` folder carry
over (README, *Updating*).

| Version | Security fixes |
|---|---|
| Latest 0.x release | Yes |
| Older releases | No. Update to the latest release |

## How we announce fixes

- Fixes ship as a new release, with a GitHub security advisory and a **Security** section in
  [`CHANGELOG.md`](CHANGELOG.md).
- For critical vulnerabilities we request a CVE, and notify users through the release notes before or
  alongside the fix.

## What's in scope

The bundle runs on the user's own computer and drives an AI coding agent, so we especially want to
hear about:

- ways the agent could be steered (prompt injection) by text from SaaS Manager or AWS Marketplace
  into running commands, reading secrets or sending data somewhere unexpected;
- ways to read `.env`, AWS credentials or the stored SaaS Manager secret, or to make them appear in the
  agent's conversation;
- outbound connections beyond those listed in `src/egress.ts`;
- anything in the dashboard (`CONSOLIDATION-REPORT.html`) that could load or send data.

Issues in 1Password SaaS Manager itself, AWS Marketplace or the AI agents are out of scope here;
report them to those vendors.
