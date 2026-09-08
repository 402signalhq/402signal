# SQLite component backup and recovery

The hosted service uses PostgreSQL as its payment replay authority. This guide
covers the SQLite components: catalog, history and the MainNet transparency log,
plus the retained, fenced SQLite replay source. A SQLite bundle is not a complete
backup of the PostgreSQL authority and cannot establish continuity of its
acknowledged payment identities. The archived TestNet log remains separate and
must also be retained; never merge its leaves into MainNet.

Production recovery also requires separately preserved PostgreSQL recovery
material and continuity evidence. Keep paid admission stopped until every
acknowledged economic identity and pending or unknown settlement is reconciled.
Follow the [PostgreSQL authority and instance-fence contract](runbooks/managed-postgres-functions.md)
before any deliberate authority reactivation. Do not promote the fenced SQLite
source, clear the instance fence, or treat a stale backup as current authority.
The separate lab accounting database is not the router's replay authority.

```bash
PYTHONPATH=. python3 scripts/backup_sqlite.py --dest /operator/backup-staging
PYTHONPATH=. python3 scripts/restore_bundle.py --bundle /operator/backup-staging/BUNDLE \
  --expected-origin 402signal.com/pq/log/mainnet-v1 \
  --expected-vkey-file /operator/trusted-public-log-vkey.txt
```

Use the exact configured SQLite paths; the defaults use `/data`. The tool
acquires every SQLite writer lock, replay first, before copying through SQLite's
backup API. It does not lock, copy or pause PostgreSQL, so these locks do not
establish a consistent recovery point across PostgreSQL and SQLite. Coordinate
the stopped writers and recovery boundary separately. No source database is
rewritten. Locks time out after five seconds if a SQLite writer cannot quiesce.
A failed or partial SQLite backup produces no complete manifest.

Each bundle contains role/schema metadata, file hashes, integrity checks and
the public log identity. Verification requires origin and vkey from an
independently retained trusted source. The manifest's hash alone does not
authenticate a backup: keep the bundle and its integrity record in restricted,
encrypted off-host storage. Record its timestamp and retention/deletion policy.
Wallet keys and operator credentials are not copied by this tool.

Rehearse restore by adding `--dest /operator/new-restore-directory` to
`restore_bundle.py`. The directory must not already exist. The tool checks the
entire bundle before creating it and checks the resulting files again. Output
names are `catalog.sqlite`, `history.sqlite`, `pq_log.sqlite`, `replay.sqlite`;
they are intentionally not installed over live paths. Restore verification must
use an isolated, explicitly approved destination. For a PostgreSQL-backed
deployment, the emitted `replay.sqlite` is retained source evidence, not an
authority to activate. Promotion of the SQLite components requires stopped
writers and a reviewed recovery point consistent with the PostgreSQL authority;
this command does not perform that reconciliation. Preserve the archived
TestNet shard separately. Do not overwrite newer payment records with an older
ledger or resume paid admission while post-snapshot activity is unresolved.

Never delete `live402-replay.sqlite` to resolve capacity or readiness failures.
Economic identities do not expire. Individual `restore_sqlite.py` replacement
is restricted to `LIVE402_FIXTURE=1` for isolated historical drills. It is not
a production recovery path.

The actual Fly snapshot schedule, last successful backup, retention, off-host
copies and alert owner must be checked by 402ops. Repository comments do not
prove that backups are active. This patch adds tooling, not a claimed schedule.
See [the rollout runbook](remediation-rollout.md) for migration and recovery gates.

The standalone `pq_log_restore_drill.py` remains a fixture-only Merkle identity
drill. It refuses `/data`, never produces a production recovery manifest, and
does not require or obtain payment authority.
