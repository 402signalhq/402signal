# Contributing

Thanks for looking. This repository holds the hosted 402Signal service, the
`sdk/route-guard` client, the MCP server and the controlled lab used to
qualify payment profiles.

## Run the tests locally

Python 3.12.14 and Node 24, matching CI.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements.txt
LIVE402_FIXTURE=1 PYTHONPATH=. python -m unittest discover -s tests
npm --prefix sdk/route-guard test
```

Fixture mode keeps every catalog and seller response synthetic. No test needs
a wallet, a facilitator or network access.

## Branches, commits and pull requests

- Branch names: `feat/`, `fix/`, `ops/`, `docs/` plus a short slug.
- Keep pull requests focused. One behaviour change per PR is easier to review
  than a week of work in one diff.
- Every PR runs the fixture suite, CodeQL and the PostgreSQL contract job; all
  three must be green and the branch must be current with `main`.
- Changes under the paths listed in `.github/CODEOWNERS` (payment, replay,
  probe, signer wire, workflows) touch money or trust. Say in the PR what
  could go wrong and how the tests prove it does not.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user of the
  API, the SDK or the MCP server would notice.
- Never commit secrets, wallet material, payment headers or production
  configuration. Fixture keys in `tests/` are public by design.

## Releases

Router releases go out on a weekly train from `main` through the gated
`deploy-router` workflow. Client packages are published from version tags with
provenance. Production installs and database changes happen only in a planned
window with a fresh backup.

## Security reports

See `SECURITY.md`. Do not open public issues for unfixed vulnerabilities.
