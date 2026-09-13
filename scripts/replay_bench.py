"""Replay admission throughput against a disposable functions-v1 authority.

Drives the router's real PostgresStore reserve/finish path with synthetic
identities in P processes (router processes) x T threads (concurrent paid
requests per process). Prints JSON only: no DSN, credential or row content.

Refuses to run unless LIVE402_BENCH_ACK=disposable-benchmark-authority and the
database host names the disposable cluster given in BENCH_CLUSTER_ID. The connection
string comes from BENCH_DATABASE_URL (a Fly app secret on the benchmark app).
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import re
import secrets
import threading
import time

BENCH_CLUSTER_ENV = "BENCH_CLUSTER_ID"
SCOPE = "5" * 64


def settings(authority: str) -> dict:
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    cfg = conninfo_to_dict(os.environ["BENCH_DATABASE_URL"])
    cluster = os.environ.get(BENCH_CLUSTER_ENV, "").strip()
    if not re.fullmatch(r"[a-z0-9]{8,32}", cluster) or cluster not in cfg.get("host", ""):
        raise SystemExit("BENCH_CLUSTER_ID must name the disposable cluster in the database host")
    keep = {k: v for k, v in cfg.items() if k in {"host", "port", "dbname", "user", "password"}}
    override = os.environ.get("BENCH_HOST", "")
    if override:
        if not re.fullmatch(r"[a-z0-9.-]{1,253}", override) or cluster not in override:
            raise SystemExit("invalid BENCH_HOST")
        keep["host"] = override
    keep["sslmode"] = "verify-full"
    # psycopg's bundled libpq/OpenSSL cannot locate the OS store for "system";
    # Fly Managed Postgres presents a Let's Encrypt certificate.
    keep["sslrootcert"] = os.environ.get("BENCH_SSLROOTCERT", "/etc/ssl/certs/ca-certificates.crt")
    return {
        "LIVE402_REPLAY_AUTHORITY_ID": authority,
        "LIVE402_REPLAY_POSTGRES_DSN": make_conninfo(**keep),
        "LIVE402_REPLAY_POSTGRES_API": "functions-v1",
    }


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def summary_ms(values):
    return {name: (None if (v := percentile(values, q)) is None else round(v * 1000, 2))
            for name, q in (("p50", 0.50), ("p95", 0.95), ("p99", 0.99))}


def admission(store):
    key = secrets.token_hex(32)
    now = time.time()
    started = time.perf_counter()
    if not store.reserve(key, SCOPE, now + 120, authorization_expires=now + 60):
        raise RuntimeError("duplicate identity")
    reserved = time.perf_counter()
    store.finish(key, "settled", None, False)
    return reserved - started, time.perf_counter() - started


def process_main(authority, threads, warmup, seconds, queue):
    from live402.replay_postgres import PostgresStore

    store = PostgresStore(environ=settings(authority))
    begin = time.monotonic() + warmup
    stop = begin + seconds
    lock = threading.Lock()
    samples, errors = [], [0]

    def worker():
        local, failed = [], 0
        while True:
            now = time.monotonic()
            if now >= stop:
                break
            try:
                reserve_s, total_s = admission(store)
            except Exception:
                failed += 1
                time.sleep(0.05)
                continue
            if now >= begin:
                local.append((reserve_s, total_s))
        with lock:
            samples.extend(local)
            errors[0] += failed

    pool = [threading.Thread(target=worker) for _ in range(threads)]
    for thread in pool:
        thread.start()
    for thread in pool:
        thread.join()
    store.close()
    queue.put((samples, errors[0]))


def run_level(authority, processes, threads, warmup, seconds):
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    procs = [ctx.Process(target=process_main, args=(authority, threads, warmup, seconds, queue))
             for _ in range(processes)]
    for proc in procs:
        proc.start()
    results = [queue.get(timeout=warmup + seconds + 180) for _ in procs]
    for proc in procs:
        proc.join()
    samples = [sample for batch, _ in results for sample in batch]
    return {
        "processes": processes,
        "threads_per_process": threads,
        "seconds": seconds,
        "admissions": len(samples),
        "per_second": round(len(samples) / seconds, 1),
        "errors": sum(failed for _, failed in results),
        "admission_ms": summary_ms([total for _, total in samples]),
        "reserve_ms": summary_ms([reserve for reserve, _ in samples]),
    }


def round_trip(authority, count=200):
    import psycopg
    from psycopg.conninfo import conninfo_to_dict

    cfg = conninfo_to_dict(settings(authority)["LIVE402_REPLAY_POSTGRES_DSN"])
    samples = []
    with psycopg.connect(**cfg, autocommit=True, connect_timeout=5) as conn:
        for _ in range(count):
            started = time.perf_counter()
            conn.execute("SELECT 1").fetchone()
            samples.append(time.perf_counter() - started)
        fence = conn.execute(
            "SELECT inet_server_addr() IS NOT DISTINCT FROM p.instance_server_addr, "
            "(extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint = p.instance_start_us "
            "FROM signal_replay.runtime_policy p").fetchone()
    return {"select1_ms": summary_ms(samples), "fence_addr_matches": fence[0], "fence_start_matches": fence[1]}


def parse_levels(raw):
    levels = []
    for item in raw.split(","):
        match = re.fullmatch(r"(\d{1,2})x(\d{1,3})", item.strip().lower())
        if not match or not (1 <= int(match[1]) <= 32 and 1 <= int(match[2]) <= 256):
            raise SystemExit("invalid level %r (use PROCESSESxTHREADS)" % item)
        levels.append((int(match[1]), int(match[2])))
    return levels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authority", required=True)
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--levels", default="1x1,1x4,1x16,1x64,2x16,4x16,8x16")
    args = parser.parse_args()
    if os.environ.get("LIVE402_BENCH_ACK") != "disposable-benchmark-authority":
        raise SystemExit("set LIVE402_BENCH_ACK=disposable-benchmark-authority")
    if not re.fullmatch(r"[0-9a-f]{32}", args.authority):
        raise SystemExit("invalid authority id")
    if not (1 <= args.seconds <= 600 and 0 <= args.warmup <= 60):
        raise SystemExit("invalid duration")
    levels = parse_levels(args.levels)
    from live402.replay_postgres import PostgresStore

    store = PostgresStore(environ=settings(args.authority))
    ready = bool(store.ready())
    store.close()
    print(json.dumps({"baseline": round_trip(args.authority), "store_ready": ready}), flush=True)
    if not ready:
        raise SystemExit(1)
    for processes, threads in levels:
        print(json.dumps(run_level(args.authority, processes, threads, args.warmup, args.seconds)), flush=True)


if __name__ == "__main__":
    main()
