/** Private bounded owner/merchant journal. No callbacks, expiry renewal or retries. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, lstatSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { assert, canonical, parseJson } from "./json.mjs";
export class AlgorandManifestStore {
    db;
    constructor(path) {
        assert(path !== ":memory:" || process.env.LIVE402_FIXTURE === "1", "durable_journal_required");
        if (path !== ":memory:") {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            assert(!existsSync(path) ||
                (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()), "journal_path_refused");
        }
        this.db = new DatabaseSync(path);
        try {
            const names = this.db
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all();
            assert(names.every((x) => ["manifest_meta", "manifest_records"].includes(x.name)), "foreign_database_refused");
            if (names.length)
                assert(this.db
                    .prepare("SELECT value FROM manifest_meta WHERE key='schema'")
                    .get()?.value === "algorand-manifest-v2", "foreign_database_refused");
            this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS manifest_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT OR IGNORE INTO manifest_meta VALUES('schema','algorand-manifest-v2'); CREATE TABLE IF NOT EXISTS manifest_records(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
            if (path !== ":memory:")
                chmodSync(path, 0o600);
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    get(key) {
        assert(/^[0-9a-f]{64}$/.test(key), "journal_key_refused");
        const row = this.db
            .prepare("SELECT value FROM manifest_records WHERE key=?")
            .get(key);
        return row ? parseJson(row.value, 49152) : undefined;
    }
    once(key, value) {
        assert(/^[0-9a-f]{64}$/.test(key), "journal_key_refused");
        const text = canonical(value);
        parseJson(text, 49152);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const old = this.get(key);
            if (old !== undefined) {
                assert(canonical(old) === text, "journal_scope_conflict");
                this.db.exec("COMMIT");
                return false;
            }
            assert(Number(this.db
                .prepare("SELECT count(*) AS n FROM manifest_records")
                .get().n) < 10000, "journal_capacity_reached");
            this.db
                .prepare("INSERT INTO manifest_records VALUES(?,?)")
                .run(key, text);
            this.db.exec("COMMIT");
            return true;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=algorand-manifest-store.js.map