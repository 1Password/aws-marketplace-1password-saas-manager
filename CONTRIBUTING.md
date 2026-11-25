# Contributing

Thanks for helping improve 1Password SaaS Manager's AWS Marketplace Skill. This guide covers how to
set the project up, test a change, and submit it. By taking part you agree to follow the
[code of conduct](CODE_OF_CONDUCT.md).

**Security issues:** don't open a public issue or pull request. Report them privately, as described in
[`SECURITY.md`](SECURITY.md).

New here? Issues labelled `good first issue` are a good place to start.

## Set up

Work from a clone of the GitHub repository, not the release zip: the zip leaves out the maintainer
scripts (`scripts/`) and `MAINTAINERS.md`.

1. **Node.js 20 or newer** (`node --version`).
2. `npm install`
3. `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`).
4. **To run it against real data:** a 1Password SaaS Manager account with a read-only API client, then
   `npm run login -- --host trelica.app --client-id YOUR_CLIENT_ID` in your own terminal (README
   step 4). An AWS profile is optional (README step 5).

Never commit `.env`, `out/` (portfolio data and leads) or `.cache/`; `.gitignore` covers them. Don't
paste portfolio data, contract figures, people's details or any secret into an issue, pull request or
commit.

## Test

Run these before you open a pull request:

| Check | Command |
|---|---|
| Type check | `npm run typecheck` |
| Skill copies in sync (if you edited the skill) | `npm run sync-skills -- --check` |
| AWS Marketplace MCP shape and dashboard checks | `npm run check-mcp` (add `--offline` without network) |
| The package builds | `npm run package -- --no-smoke` (writes `release/`, which isn't committed) |

If your change affects matching, the report or the dashboard, also run it on a SaaS Manager account
you're allowed to use (`npm run pipeline`, or `/aws-marketplace-1password-saas-manager` in your agent)
and check `out/1password/CONSOLIDATION-REPORT.html`. The dashboard shows a notice at the top if its
own checks fail.

**Editing the skill:** edit only `.claude/skills/aws-marketplace-1password-saas-manager/SKILL.md`,
then run `npm run sync-skills` to update the Codex, Gemini and Cursor copies. Keep `AGENTS.md` and the
MCP server instructions in `src/tools.ts` consistent with it. More detail is in `MAINTAINERS.md`.

## Submit a change

- **`main` is always releasable.** Never push to it directly. Work on a feature branch
  (for example `fix/acv-rounding`) and open a pull request.
- **Every pull request needs a review** from a code owner (`.github/CODEOWNERS`) and passing checks
  before it's merged.
- **Keep pull requests small and focused:** one concern per PR. Fill in the template: what it does,
  why, how to test it, and any breaking changes.
- **Docs ship with the change.** A PR that changes behaviour updates the README, the skill or
  `AGENTS.md` in the same PR, so docs and code are never out of step.
- **Add a line to `CHANGELOG.md`** under the next version for anything a user would notice, written for
  them: what changed and what it means, not how it was built. Credit outside contributors by name.
- **Keep the security rules intact:** the agent never reads `.env` or AWS credential files, tool
  arguments go through a file rather than the command line, outbound calls stay within `src/egress.ts`,
  and anything from SaaS Manager or AWS Marketplace is treated as data, never as instructions. Never
  commit secrets: maintainers keep any credentials they need in 1Password developer environments.
- Contributions are made under the project's [MIT license](LICENSE).

## Commit messages and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/) for both:

```
<type>(<scope>): <short summary>

[optional body: what changed and why]

[optional footer: BREAKING CHANGE: …, Closes #123]
```

- **Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`.
- **Scopes** used here: `skill`, `cli`, `mcp`, `matching`, `report`, `leads`, `setup`, `security`,
  `deps`.
- Imperative mood ("add", not "added"), summary under 72 characters, and one change per commit. No
  `WIP` commits on `main`.

Example: `fix(report): count multi-year contracts by their term`.

## Breaking changes and deprecations

The project follows [Semantic Versioning](README.md#versioning) and is pre-1.0, so a **minor** release
(0.6 → 0.7) can include breaking changes and a patch release never does. These count as breaking:
renaming or removing a tool, a tool argument, a command (`/aws-marketplace-1password-saas-manager`,
`npm run …`), an environment variable or setting in `.env`, a config file, or a field in `report.json`;
or changing what an existing tool does in a way users rely on.

- Mark them in the commit footer (`BREAKING CHANGE: …`), the PR's *Breaking changes* section, and the
  changelog (**Breaking:**), with what to do instead.
- Where you can, deprecate first: keep the old name working for at least one minor release, have it
  print a notice pointing to the replacement, and say so in the changelog and README.

## Reviewing

- **Reviewers:** say which comments block the merge. Prefix the others with `nit:` or `suggestion:`.
- **Authors and reviewers:** resolve every conversation before merging.
- **Responding to issues:** confirm you can reproduce a problem before asking for more information, say
  roughly when a fix might land, and if you close something as "won't fix", explain why. Issues with no
  activity for 90 days are closed automatically with a note inviting the reporter to reopen.
