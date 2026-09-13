## What changes

## Why

## Risk

- [ ] Touches a CODEOWNERS path (payment, replay, probe, signer wire, workflows)? If yes, what could go wrong and which test proves it does not.
- [ ] No secrets, wallet material or production configuration in the diff.
- [ ] `CHANGELOG.md` updated if a user of the API, SDK or MCP server would notice.

## How it was tested

Fixture suite, SDK tests, PostgreSQL contract job, or a lab run (say which).
