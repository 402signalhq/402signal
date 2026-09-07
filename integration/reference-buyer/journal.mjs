import { DatabaseSync } from "node:sqlite";
import {
  constants as C,
  closeSync,
  openSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { check, canonical, digest, atomic } from "./policy.mjs";
/** Buyer-private immutable campaign. Reservations are never silently refunded. */
export class BuyerJournal {
  #db;
  #cap;
  constructor(directory, policy) {
    check(process.platform !== "win32", "posix_store_required");
    directory = resolve(directory);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const dir = lstatSync(directory);
    check(
      dir.isDirectory() &&
        !dir.isSymbolicLink() &&
        (dir.mode & 0o077) === 0 &&
        dir.uid === process.getuid(),
      "private_journal_required",
    );
    const path = join(directory, "buyer.sqlite");
    try {
      const f = openSync(
        path,
        C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
        0o600,
      );
      fsyncSync(f);
      closeSync(f);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const st = lstatSync(path);
    check(
      st.isFile() &&
        !st.isSymbolicLink() &&
        (st.mode & 0o077) === 0 &&
        st.uid === process.getuid(),
      "private_journal_required",
    );
    this.#db = new DatabaseSync(path);
    try {
      const tables = this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((x) => x.name);
      check(
        tables.length === 0 ||
          (tables.length === 3 &&
            ["reference_meta", "reference_jobs", "reference_records"].every(
              (x) => tables.includes(x),
            )),
        "foreign_database_refused",
      );
      if (tables.length)
        check(
          this.#db
            .prepare("SELECT value FROM reference_meta WHERE name=?")
            .get("schema")?.value === "reference-buyer-v1",
          "foreign_database_refused",
        );
      this.#db.exec(
        "PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000;",
      );
      this.#db.exec(
        "CREATE TABLE IF NOT EXISTS reference_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reference_jobs(id TEXT PRIMARY KEY,reserved INTEGER NOT NULL,state TEXT NOT NULL,request TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reference_records(job TEXT NOT NULL,part TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(job,part));",
      );
      this.#db
        .prepare("INSERT OR IGNORE INTO reference_meta VALUES (?,?)")
        .run("schema", "reference-buyer-v1");
      this.#cap = atomic(policy.campaignMaximumAtomic);
      this.#db
        .prepare("INSERT OR IGNORE INTO reference_meta VALUES (?,?)")
        .run("policy", digest(policy));
      check(
        this.#db
          .prepare("SELECT value FROM reference_meta WHERE name=?")
          .get("policy").value === digest(policy),
        "campaign_policy_changed",
      );
      for (const d of [directory, dirname(directory)]) {
        const f = openSync(d, C.O_RDONLY | C.O_DIRECTORY);
        fsyncSync(f);
        closeSync(f);
      }
    } catch (e) {
      this.#db.close();
      throw e;
    }
  }
  reserve(id, request, maximumAtomic) {
    check(
      typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id),
      "invalid_job_id",
    );
    const n = atomic(maximumAtomic);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      check(
        !this.#db.prepare("SELECT 1 FROM reference_jobs WHERE id=?").get(id),
        "job_already_reserved",
      );
      check(
        !this.#db
          .prepare(
            "SELECT 1 FROM reference_jobs WHERE state NOT IN ('complete','free_miss')",
          )
          .get(),
        "prior_job_unresolved",
      );
      const row = this.#db
        .prepare(
          "SELECT COUNT(*) n,COALESCE(SUM(reserved),0) spent FROM reference_jobs",
        )
        .get();
      check(
        row.n < 5000 && BigInt(row.spent) + n <= this.#cap,
        "campaign_budget_exhausted",
      );
      this.#db
        .prepare("INSERT INTO reference_jobs VALUES (?,?,?,?)")
        .run(id, Number(n), "reserved", canonical(request));
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  job(id) {
    const x = this.#db
      .prepare("SELECT * FROM reference_jobs WHERE id=?")
      .get(id);
    check(x, "unknown_job");
    return { ...x, request: JSON.parse(x.request) };
  }
  put(id, part, value) {
    this.job(id);
    check(
      typeof part === "string" && /^[a-z_]{1,64}$/.test(part),
      "invalid_record_part",
    );
    const raw = JSON.stringify(value);
    check(Buffer.byteLength(raw) <= 1048576, "record_too_large");
    const r = this.#db
      .prepare("INSERT OR IGNORE INTO reference_records VALUES (?,?,?)")
      .run(id, part, raw);
    check(r.changes === 1, "stage_already_claimed");
  }
  get(id, part) {
    const x = this.#db
      .prepare("SELECT value FROM reference_records WHERE job=? AND part=?")
      .get(id, part);
    return x ? JSON.parse(x.value) : undefined;
  }
  finish(id, state) {
    check(["complete", "free_miss"].includes(state), "invalid_terminal_state");
    check(
      this.#db
        .prepare(
          "UPDATE reference_jobs SET state=? WHERE id=? AND state='reserved'",
        )
        .run(state, id).changes === 1,
      "job_already_finished",
    );
  }
  close() {
    this.#db.close();
  }
}
