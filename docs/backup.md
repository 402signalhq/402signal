# SQLite backup and recovery

Production recovery requires a complete bundle of catalog, history, MainNet
transparency log and the payment replay ledger. The archived TestNet log remains
separate and must also be retained; never merge its leaves into MainNet.

```bash
PYTHONPATH=. python3 scripts/backup_sqlite.py --dest /operator/backup-staging
PYTHONPATH=. python3 scripts/restore_bundle.py --bundle /operator/backup-staging/BUNDLE \
  --expected-origin 402signal.com/pq/log/mainnet-v1 \
  --expected-vkey-file /operator/trusted-public-log-vkey.txt
```

Use the exact configured database paths. Defaults match the production `/data`
paths. The tool acquires every SQLite writer lock, replay first, before copying
any database through SQLite's backup API. No database is rewritten. Existing
inflight settlements have a pending replay record; new reservations cannot
proceed during the snapshot. Locks time out after five seconds if a writer
cannot quiesce. A failed or partial backup produces no complete manifest.

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
they are intentionally not installed over live paths. With the service stopped,
the operator promotes the complete verified set to its configured filenames,
preserving the archived TestNet shard separately. Do not partially restore or
overwrite newer payment records with an older replay ledger. Reconcile all
post-snapshot activity and preserve pending/unknown economic records before
resuming paid admission.

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
