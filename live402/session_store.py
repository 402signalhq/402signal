"""Session store backends: the per-machine SQLite file or the shared replay PostgreSQL.

The session store holds hosted windows, issued check credits, the private
counters and payer days, and alert subscriptions with their deliveries. On one
machine it is the SQLite file on the volume. For more than one machine it moves
to the replay authority (`ops/session-postgres-managed.sql`): every write goes
through an owner function that refuses every login except the pinned replay
runtime login, and reads use that login's read-only access. The observation
cache is per machine in either case and stays in `live402.session`.

Backends (LIVE402_SESSION_BACKEND):
  sqlite    the volume file. Default.
  postgres  the replay database, with the same connection settings as the
            replay authority (LIVE402_REPLAY_POSTGRES_DSN and friends).

Both backends expose the same methods. Nothing here retries: a failed
operation raises StoreUnavailable and the caller fails closed (a hop answers
503, a credit reads as spent, an alert call answers 503).
"""

from __future__ import annotations

import json
import os
import threading
import time

BACKENDS = frozenset({"sqlite", "postgres"})
MAX_CONNECTION_AGE = 600
SESSION_SETTINGS = (
    "SET LOCAL statement_timeout = '2000ms'",
    "SET LOCAL lock_timeout = '1000ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '3000ms'",
)
WINDOW_COLS = (
    "expires_at, hop_count, hop_ceiling, url, rail, scheme, fingerprint, mandate_hash, offer_json, traffic_class"
)
SUB_COLS = (
    "id, owner, url, hosts_json, events_json, secret, created_at, cursor_ts, state_json, "
    "last_delivery_at, last_status, failures, next_attempt_at, disabled_at, disabled_reason"
)
DELIVERY_COLS = "id, ts, kind, status, events, error"
EXPORT_WINDOW_S = 35 * 86400
EXPORT_TRIAL_GRACE_S = 7 * 86400


class StoreUnavailable(Exception):
    """The session store cannot be reached or refused the operation. Callers fail closed."""


def backend_name() -> str:
    """Configured backend. Raises ValueError for an unknown value (fail closed)."""
    raw = (os.environ.get("LIVE402_SESSION_BACKEND") or "").strip().lower()
    if not raw:
        return "sqlite"
    if raw not in BACKENDS:
        raise ValueError("invalid session backend")
    return raw


def _marks(values) -> str:
    return ",".join("?" * len(values))


class SqliteStore:
    """The volume file. `connect` returns the shared connection; `lock` serializes it."""

    name = "sqlite"

    def __init__(self, connect, lock):
        self._connect = connect
        self._lock = lock

    def close(self) -> None:
        return None

    # windows

    def window_insert(self, row: dict) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "INSERT INTO windows (id_hash, created_at, expires_at, observed_at, hop_count, hop_ceiling, "
                "url, rail, scheme, fingerprint, mandate_hash, offer_json, traffic_class, trial_hash, sku) "
                "VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["id_hash"], int(row["created_at"]), int(row["expires_at"]), int(row["created_at"]),
                    int(row["hop_ceiling"]), row["url"], row["rail"], row["scheme"], row["fingerprint"],
                    row["mandate_hash"], row["offer_json"], row["traffic_class"], row["trial_hash"], row["sku"],
                ),
            )
            conn.commit()

    def window_get(self, id_hash: str):
        with self._lock:
            return self._connect().execute(
                "SELECT " + WINDOW_COLS + " FROM windows WHERE id_hash = ?", (id_hash,)
            ).fetchone()

    def window_hop(self, id_hash: str, now: int):
        """The new hop count, or None when the window is unknown, expired or spent."""
        with self._lock:
            conn = self._connect()
            cur = conn.execute(
                "UPDATE windows SET hop_count = hop_count + 1 "
                "WHERE id_hash = ? AND hop_count < hop_ceiling AND expires_at >= ?",
                (id_hash, int(now)),
            )
            if cur.rowcount != 1:
                conn.commit()
                return None
            row = conn.execute("SELECT hop_count FROM windows WHERE id_hash = ?", (id_hash,)).fetchone()
            conn.commit()
            return int(row[0]) if row else None

    # check credits

    def trial_issue(self, digest: str, now: int, expires_at: int, opens: int) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "INSERT INTO trial_credits (token_hash, created_at, expires_at, opens_used, open_ceiling) "
                "VALUES (?, ?, ?, 0, ?) "
                "ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at, "
                "open_ceiling = MAX(trial_credits.open_ceiling, excluded.open_ceiling)",
                (digest, int(now), int(expires_at), int(opens)),
            )
            conn.commit()

    def trial_get(self, digest: str):
        with self._lock:
            return self._connect().execute(
                "SELECT expires_at, opens_used, open_ceiling FROM trial_credits WHERE token_hash = ?", (digest,)
            ).fetchone()

    def trial_consume(self, digest: str, now: int) -> bool:
        with self._lock:
            conn = self._connect()
            cur = conn.execute(
                "UPDATE trial_credits SET opens_used = opens_used + 1 "
                "WHERE token_hash = ? AND expires_at >= ? AND opens_used < open_ceiling",
                (digest, int(now)),
            )
            conn.commit()
            return cur.rowcount == 1

    # private counters and payer days

    def counters_add(self, day: str, rows) -> None:
        with self._lock:
            conn = self._connect()
            conn.executemany(
                "INSERT INTO metric_counters (day, name, n) VALUES (?, ?, ?) "
                "ON CONFLICT(day, name) DO UPDATE SET n = n + excluded.n",
                [(day, name, int(n)) for name, n in rows],
            )
            conn.commit()

    def counters_sum(self, days, *, name: str | None = None, prefix: str | None = None) -> int:
        days = list(days)
        if name is not None:
            sql = "SELECT coalesce(sum(n), 0) FROM metric_counters WHERE name = ? AND day IN (%s)" % _marks(days)
            params = [name, *days]
        else:
            sql = "SELECT coalesce(sum(n), 0) FROM metric_counters WHERE name LIKE ? AND day IN (%s)" % _marks(days)
            params = [str(prefix or "") + "%", *days]
        with self._lock:
            return int(self._connect().execute(sql, params).fetchone()[0] or 0)

    def counters_by_name(self, days) -> dict:
        days = list(days)
        with self._lock:
            rows = self._connect().execute(
                "SELECT name, sum(n) FROM metric_counters WHERE day IN (%s) GROUP BY name" % _marks(days), days
            ).fetchall()
        return {str(name): int(total or 0) for name, total in rows}

    def payer_record(self, day: str, payer_hash: str, traffic: str) -> bool:
        with self._lock:
            conn = self._connect()
            cur = conn.execute(
                "INSERT OR IGNORE INTO payer_days (day, payer_hash, traffic) VALUES (?, ?, ?)",
                (day, payer_hash, traffic),
            )
            conn.commit()
            return cur.rowcount == 1

    def payers_distinct(self, days, traffic: str | None = None) -> int:
        days = list(days)
        if traffic is None:
            sql = "SELECT count(DISTINCT payer_hash) FROM payer_days WHERE day IN (%s)" % _marks(days)
            params = days
        else:
            sql = "SELECT count(DISTINCT payer_hash) FROM payer_days WHERE traffic = ? AND day IN (%s)" % _marks(days)
            params = [traffic, *days]
        with self._lock:
            return int(self._connect().execute(sql, params).fetchone()[0] or 0)

    # alert subscriptions

    def alert_sub_get(self, sub_id: str, owner: str):
        with self._lock:
            return self._connect().execute(
                "SELECT " + SUB_COLS + " FROM alert_subscriptions WHERE id = ? AND owner = ?", (sub_id, owner)
            ).fetchone()

    def alert_sub_list(self, owner: str) -> list:
        with self._lock:
            return self._connect().execute(
                "SELECT " + SUB_COLS + " FROM alert_subscriptions WHERE owner = ? ORDER BY created_at, id", (owner,)
            ).fetchall()

    def alert_sub_due(self, ts: int) -> list:
        with self._lock:
            return self._connect().execute(
                "SELECT " + SUB_COLS + " FROM alert_subscriptions "
                "WHERE disabled_at IS NULL AND next_attempt_at <= ? ORDER BY created_at, id",
                (int(ts),),
            ).fetchall()

    def alert_sub_create(self, sub_id, owner, url, hosts_json, events_json, secret, ts, state_json, max_per_owner) -> bool:
        with self._lock:
            conn = self._connect()
            count = conn.execute("SELECT count(*) FROM alert_subscriptions WHERE owner = ?", (owner,)).fetchone()[0]
            if int(count) >= int(max_per_owner):
                return False
            conn.execute(
                "INSERT INTO alert_subscriptions (id, owner, url, hosts_json, events_json, secret, created_at, "
                "cursor_ts, state_json) VALUES (?,?,?,?,?,?,?,?,?)",
                (sub_id, owner, url, hosts_json, events_json, secret, int(ts), int(ts), state_json),
            )
            conn.commit()
            return True

    def alert_sub_cursor(self, sub_id: str, cursor_ts: int, state_json: str) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "UPDATE alert_subscriptions SET cursor_ts = ?, state_json = ? WHERE id = ? AND disabled_at IS NULL",
                (int(cursor_ts), state_json, sub_id),
            )
            conn.commit()

    def alert_sub_delivered(self, sub_id, ts, status, cursor_ts=None, state_json=None) -> None:
        sets = ("failures = 0, next_attempt_at = 0, last_delivery_at = ?, last_status = ?, "
                "disabled_at = NULL, disabled_reason = NULL")
        args: list = [int(ts), int(status)]
        if cursor_ts is not None:
            sets += ", cursor_ts = ?, state_json = ?"
            args += [int(cursor_ts), state_json]
        with self._lock:
            conn = self._connect()
            conn.execute("UPDATE alert_subscriptions SET %s WHERE id = ?" % sets, (*args, sub_id))
            conn.commit()

    def alert_sub_failed(self, sub_id, failures, next_attempt_at, status, disabled_at, disabled_reason) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "UPDATE alert_subscriptions SET failures = ?, next_attempt_at = ?, last_status = ?, "
                "disabled_at = COALESCE(disabled_at, ?), disabled_reason = COALESCE(disabled_reason, ?) WHERE id = ?",
                (int(failures), int(next_attempt_at), status, disabled_at, disabled_reason, sub_id),
            )
            conn.commit()

    def alert_sub_delete(self, sub_id: str, owner: str) -> bool:
        with self._lock:
            conn = self._connect()
            if not conn.execute(
                "SELECT 1 FROM alert_subscriptions WHERE id = ? AND owner = ?", (sub_id, owner)
            ).fetchone():
                return False
            conn.execute("DELETE FROM alert_deliveries WHERE subscription_id = ?", (sub_id,))
            conn.execute("DELETE FROM alert_subscriptions WHERE id = ? AND owner = ?", (sub_id, owner))
            conn.commit()
            return True

    def alert_delivery_add(self, delivery_id, sub_id, ts, kind, status, events, error, keep) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "INSERT INTO alert_deliveries (id, subscription_id, ts, kind, status, events, error) "
                "VALUES (?,?,?,?,?,?,?)",
                (delivery_id, sub_id, int(ts), kind, status, int(events), error),
            )
            conn.execute(
                "DELETE FROM alert_deliveries WHERE subscription_id = ? AND id NOT IN "
                "(SELECT id FROM alert_deliveries WHERE subscription_id = ? ORDER BY ts DESC, id DESC LIMIT ?)",
                (sub_id, sub_id, int(keep)),
            )
            conn.commit()

    def alert_deliveries(self, sub_id: str, limit: int) -> list:
        with self._lock:
            return self._connect().execute(
                "SELECT " + DELIVERY_COLS + " FROM alert_deliveries WHERE subscription_id = ? "
                "ORDER BY ts DESC, id DESC LIMIT ?",
                (sub_id, int(limit)),
            ).fetchall()

    def alert_deliveries_prune(self, before: int) -> int:
        with self._lock:
            conn = self._connect()
            removed = conn.execute("DELETE FROM alert_deliveries WHERE ts < ?", (int(before),)).rowcount
            conn.commit()
            return int(removed)

    # housekeeping, rollup and the one-time copy

    def prune(self, now: int, window_grace: int, trial_grace: int, cutoff_day: str) -> dict:
        with self._lock:
            conn = self._connect()
            out = {
                "windows": conn.execute(
                    "DELETE FROM windows WHERE expires_at < ?", (int(now) - int(window_grace),)).rowcount,
                "trial_credits": conn.execute(
                    "DELETE FROM trial_credits WHERE expires_at < ?", (int(now) - int(trial_grace),)).rowcount,
                "metric_counters": conn.execute(
                    "DELETE FROM metric_counters WHERE day < ?", (cutoff_day,)).rowcount,
                "payer_days": conn.execute(
                    "DELETE FROM payer_days WHERE day < ?", (cutoff_day,)).rowcount,
            }
            conn.commit()
        return out

    def rollup(self, since: int, until: int, days, traffic: str = "organic") -> dict:
        with self._lock:
            row = self._connect().execute(
                "SELECT count(*), coalesce(sum(hop_count), 0) FROM windows "
                "WHERE traffic_class = ? AND sku = 'session' AND created_at >= ? AND created_at < ?",
                (traffic, int(since), int(until)),
            ).fetchone()
        return {
            "opens": int(row[0]), "hops": int(row[1]),
            "counters": self.counters_by_name(days),
            "distinct_payers": self.payers_distinct(days, traffic),
        }

    def meta_get(self, key: str):
        with self._lock:
            row = self._connect().execute("SELECT value FROM session_meta WHERE key = ?", (key,)).fetchone()
        return None if row is None else str(row[0])

    def meta_set(self, key: str, value: str) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                "INSERT INTO session_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            conn.commit()

    def export_state(self, now: int) -> dict:
        """Rows worth carrying to a shared store: live windows, unexpired credits, counters, payers, alerts."""
        def rows(conn, sql, params=()):
            cur = conn.execute(sql, params)
            names = [d[0] for d in cur.description]
            return [dict(zip(names, r)) for r in cur.fetchall()]

        with self._lock:
            conn = self._connect()
            return {
                "windows": rows(conn, "SELECT id_hash, created_at, expires_at, observed_at, hop_count, hop_ceiling, url, "
                                      "rail, scheme, fingerprint, mandate_hash, offer_json, traffic_class, trial_hash, sku "
                                      "FROM windows WHERE created_at >= ?", (int(now) - EXPORT_WINDOW_S,)),
                "trial_credits": rows(conn, "SELECT token_hash, created_at, expires_at, opens_used, open_ceiling "
                                            "FROM trial_credits WHERE expires_at >= ?", (int(now) - EXPORT_TRIAL_GRACE_S,)),
                "metric_counters": rows(conn, "SELECT day, name, n FROM metric_counters WHERE n > 0"),
                "payer_days": rows(conn, "SELECT day, payer_hash, traffic FROM payer_days"),
                "alert_subscriptions": rows(conn, "SELECT " + SUB_COLS + " FROM alert_subscriptions"),
                "alert_deliveries": rows(conn, "SELECT id, subscription_id, ts, kind, status, events, error FROM alert_deliveries"),
            }


class PostgresStore:
    """The shared store on the replay database: owner functions for writes, plain reads."""

    name = "postgres"

    def __init__(self, environ=None):
        env = os.environ if environ is None else environ
        try:
            import psycopg
            from psycopg.conninfo import conninfo_to_dict

            from live402.replay_postgres import validate_settings

            self.config, _authority = validate_settings(env, conninfo_to_dict)
        except Exception:
            raise StoreUnavailable("session store unavailable") from None
        self._psycopg = psycopg
        self._lock = threading.Lock()
        self._conn = None
        self._connected_at = 0.0

    def close(self) -> None:
        with self._lock:
            self._discard()

    def _discard(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _connection(self):
        conn = self._conn
        if conn is not None and (conn.closed or time.monotonic() - self._connected_at >= MAX_CONNECTION_AGE):
            self._discard()
            conn = None
        if conn is None:
            conn = self._psycopg.connect(
                **self.config, autocommit=True, connect_timeout=2,
                application_name="402signal-session", prepare_threshold=None,
            )
            self._conn, self._connected_at = conn, time.monotonic()
        return conn

    def _run(self, fn):
        """One operation in one transaction. Any failure discards the connection; nothing retries."""
        with self._lock:
            try:
                conn = self._connection()
                with conn.transaction():
                    for statement in SESSION_SETTINGS:
                        conn.execute(statement)
                    return fn(conn)
            except Exception:
                self._discard()
                raise StoreUnavailable("session store unavailable") from None

    def _one(self, sql, params=()):
        return self._run(lambda conn: conn.execute(sql, params).fetchone())

    def _all(self, sql, params=()):
        return self._run(lambda conn: conn.execute(sql, params).fetchall())

    # windows

    def window_insert(self, row: dict) -> None:
        self._one(
            "SELECT signal_session.api_window_open(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                row["id_hash"], int(row["created_at"]), int(row["expires_at"]), int(row["hop_ceiling"]),
                row["url"], row["rail"], row["scheme"], row["fingerprint"], row["mandate_hash"],
                row["offer_json"], row["traffic_class"], row["trial_hash"], row["sku"],
            ),
        )

    def window_get(self, id_hash: str):
        return self._one("SELECT " + WINDOW_COLS + " FROM signal_session.windows WHERE id_hash = %s", (id_hash,))

    def window_hop(self, id_hash: str, now: int):
        row = self._one("SELECT signal_session.api_window_hop(%s,%s)", (id_hash, int(now)))
        return None if row is None or row[0] is None else int(row[0])

    # check credits

    def trial_issue(self, digest: str, now: int, expires_at: int, opens: int) -> None:
        self._one("SELECT signal_session.api_trial_issue(%s,%s,%s,%s)", (digest, int(now), int(expires_at), int(opens)))

    def trial_get(self, digest: str):
        return self._one(
            "SELECT expires_at, opens_used, open_ceiling FROM signal_session.trial_credits WHERE token_hash = %s",
            (digest,),
        )

    def trial_consume(self, digest: str, now: int) -> bool:
        row = self._one("SELECT signal_session.api_trial_consume(%s,%s)", (digest, int(now)))
        return bool(row and row[0])

    # private counters and payer days

    def counters_add(self, day: str, rows) -> None:
        rows = [(day, str(name), int(n)) for name, n in rows if int(n) > 0]
        if not rows:
            return

        def run(conn):
            for params in rows:
                conn.execute("SELECT signal_session.api_counter_add(%s,%s,%s)", params)

        self._run(run)

    def counters_sum(self, days, *, name: str | None = None, prefix: str | None = None) -> int:
        days = list(days)
        if name is not None:
            row = self._one(
                "SELECT coalesce(sum(n), 0) FROM signal_session.metric_counters WHERE name = %s AND day = ANY(%s)",
                (name, days),
            )
        else:
            row = self._one(
                "SELECT coalesce(sum(n), 0) FROM signal_session.metric_counters WHERE name LIKE %s AND day = ANY(%s)",
                (str(prefix or "") + "%", days),
            )
        return int(row[0] or 0)

    def counters_by_name(self, days) -> dict:
        rows = self._all(
            "SELECT name, sum(n) FROM signal_session.metric_counters WHERE day = ANY(%s) GROUP BY name", (list(days),)
        )
        return {str(name): int(total or 0) for name, total in rows}

    def payer_record(self, day: str, payer_hash: str, traffic: str) -> bool:
        row = self._one("SELECT signal_session.api_payer_record(%s,%s,%s)", (day, payer_hash, traffic))
        return bool(row and row[0])

    def payers_distinct(self, days, traffic: str | None = None) -> int:
        days = list(days)
        if traffic is None:
            row = self._one("SELECT count(DISTINCT payer_hash) FROM signal_session.payer_days WHERE day = ANY(%s)", (days,))
        else:
            row = self._one(
                "SELECT count(DISTINCT payer_hash) FROM signal_session.payer_days WHERE traffic = %s AND day = ANY(%s)",
                (traffic, days),
            )
        return int(row[0] or 0)

    # alert subscriptions

    def alert_sub_get(self, sub_id: str, owner: str):
        return self._one(
            "SELECT " + SUB_COLS + " FROM signal_session.alert_subscriptions WHERE id = %s AND owner = %s",
            (sub_id, owner),
        )

    def alert_sub_list(self, owner: str) -> list:
        return self._all(
            "SELECT " + SUB_COLS + " FROM signal_session.alert_subscriptions WHERE owner = %s ORDER BY created_at, id",
            (owner,),
        )

    def alert_sub_due(self, ts: int) -> list:
        return self._all(
            "SELECT " + SUB_COLS + " FROM signal_session.alert_subscriptions "
            "WHERE disabled_at IS NULL AND next_attempt_at <= %s ORDER BY created_at, id",
            (int(ts),),
        )

    def alert_sub_create(self, sub_id, owner, url, hosts_json, events_json, secret, ts, state_json, max_per_owner) -> bool:
        row = self._one(
            "SELECT signal_session.api_alert_sub_create(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (sub_id, owner, url, hosts_json, events_json, secret, int(ts), state_json, int(max_per_owner)),
        )
        return bool(row and row[0])

    def alert_sub_cursor(self, sub_id: str, cursor_ts: int, state_json: str) -> None:
        self._one("SELECT signal_session.api_alert_sub_cursor(%s,%s,%s)", (sub_id, int(cursor_ts), state_json))

    def alert_sub_delivered(self, sub_id, ts, status, cursor_ts=None, state_json=None) -> None:
        self._one(
            "SELECT signal_session.api_alert_sub_delivered(%s,%s,%s,%s,%s)",
            (sub_id, int(ts), int(status), None if cursor_ts is None else int(cursor_ts), state_json),
        )

    def alert_sub_failed(self, sub_id, failures, next_attempt_at, status, disabled_at, disabled_reason) -> None:
        self._one(
            "SELECT signal_session.api_alert_sub_failed(%s,%s,%s,%s,%s,%s)",
            (sub_id, int(failures), int(next_attempt_at), status, disabled_at, disabled_reason),
        )

    def alert_sub_delete(self, sub_id: str, owner: str) -> bool:
        row = self._one("SELECT signal_session.api_alert_sub_delete(%s,%s)", (sub_id, owner))
        return bool(row and row[0])

    def alert_delivery_add(self, delivery_id, sub_id, ts, kind, status, events, error, keep) -> None:
        self._one(
            "SELECT signal_session.api_alert_delivery_add(%s,%s,%s,%s,%s,%s,%s,%s)",
            (delivery_id, sub_id, int(ts), kind, status, int(events), error, int(keep)),
        )

    def alert_deliveries(self, sub_id: str, limit: int) -> list:
        return self._all(
            "SELECT " + DELIVERY_COLS + " FROM signal_session.alert_deliveries WHERE subscription_id = %s "
            "ORDER BY ts DESC, id DESC LIMIT %s",
            (sub_id, int(limit)),
        )

    def alert_deliveries_prune(self, before: int) -> int:
        row = self._one("SELECT signal_session.api_alert_deliveries_prune(%s)", (int(before),))
        return int(row[0] or 0)

    # housekeeping, rollup and the one-time copy

    def prune(self, now: int, window_grace: int, trial_grace: int, cutoff_day: str) -> dict:
        row = self._one(
            "SELECT windows, trial_credits, metric_counters, payer_days FROM signal_session.api_prune(%s,%s,%s,%s)",
            (int(now), int(window_grace), int(trial_grace), cutoff_day),
        )
        keys = ("windows", "trial_credits", "metric_counters", "payer_days")
        return {key: int(value or 0) for key, value in zip(keys, row or (0, 0, 0, 0))}

    def rollup(self, since: int, until: int, days, traffic: str = "organic") -> dict:
        row = self._one(
            "SELECT count(*), coalesce(sum(hop_count), 0) FROM signal_session.windows "
            "WHERE traffic_class = %s AND sku = 'session' AND created_at >= %s AND created_at < %s",
            (traffic, int(since), int(until)),
        )
        return {
            "opens": int(row[0]), "hops": int(row[1]),
            "counters": self.counters_by_name(days),
            "distinct_payers": self.payers_distinct(days, traffic),
        }

    def imported(self, source: str) -> bool:
        return self._one("SELECT 1 FROM signal_session.imports WHERE source = %s", (source,)) is not None

    def import_state(self, source: str, payload: dict) -> bool:
        body = json.dumps(payload, separators=(",", ":"), default=str)
        row = self._one("SELECT signal_session.api_import(%s, %s::jsonb)", (source, body))
        return bool(row and row[0])
