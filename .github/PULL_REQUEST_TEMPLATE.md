<!-- Title: Conventional Commits format, e.g. "fix(report): show ACV for multi-year contracts" -->

## What does this PR do?
<!-- 1-3 sentences. What problem does it solve, and how? -->

## Why is this change needed?
<!-- Link the issue, or explain the user problem or technical-debt reason. -->

## How to test
<!-- Steps a reviewer can follow to verify the change. -->

## Breaking changes
<!-- List any (renamed or removed tools, commands, arguments, environment variables, files or report.json fields), or write "None". -->

## Screenshots / recordings
<!-- For dashboard or agent-conversation changes, before and after. Use sample data only. -->

## Checklist
- [ ] Tests or checks added or updated (`npm run check-mcp` covers MCP shape and dashboard rendering)
- [ ] `npm run typecheck` and `npm run sync-skills -- --check` pass, with no new warnings in CI
- [ ] Documentation updated in the same PR (README, skill, `AGENTS.md`)
- [ ] `CHANGELOG.md` entry added under the next version (for user-facing changes)
- [ ] No portfolio data, contract figures, people's details, secrets or internal references in the code, docs or this description
- [ ] Security rules still hold: the agent can't read `.env` or AWS credentials, tool arguments go through a file, outbound calls stay within `src/egress.ts`, and tool output is treated as data
