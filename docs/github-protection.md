# GitHub branch protection

Protection for `main` is already enabled by the active repository ruleset **Protect main**.
This file does not create, edit, or disable GitHub rulesets.

Required CI check name (job id in `.github/workflows/test.yml`):

**`test`**

CodeQL also publishes `analyze (python)` and
`analyze (javascript-typescript)`. Those names appear on the active
ruleset. This PR does not add or remove required checks.

The `test` job installs the universal dependency lock with
`--require-hashes` and runs pip-audit on that same `requirements.txt`.
Do not add a private-signer secret to this public repo.

Independent review remains an open control. The owner confirmed that
`@ross402signal` is the only account available. GitHub will not allow an author
to approve their own PR, so requiring an approval now would block every merge.
This patch expands CODEOWNERS to replay, network I/O, recovery, buyer/ledger,
SDK and workflow paths and extends read-only fixture CI with the official MCP
client test. These controls do not replace independent review.

After a trusted second reviewer is available, the repository administrator
should require at least one approval, CODEOWNERS approval, dismissal of stale
reviews and approval of the latest push. Preserve the strict required checks
listed above. Inspect the complete effective ruleset and all bypass actors;
test the resulting rule with a real feature PR. Do not enable a permanent
admin bypass merely to work around a single-account lockout.

Do not attach deployment or signer secrets to pull-request workflows. Public
fixtures use synthetic payments and `contents: read`. Only the MCP publishing
job requests OIDC, and it verifies a pinned publisher artifact before execution.

No GitHub ruleset or account permission is changed by these source files.
