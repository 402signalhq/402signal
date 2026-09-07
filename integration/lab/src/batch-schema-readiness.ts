import type { Pool } from "pg";

const schemas = {
  stages: {
    table: "public.lab_base_batch_stages_v1",
    columns: ["campaign:text:true", "stage:text:true", "value:jsonb:true"],
    constraints: [
      "CHECK ((octet_length((value)::text) <= 65536))",
      "PRIMARY KEY (campaign, stage)",
    ],
    grants: ["SELECT", "INSERT", "UPDATE"],
  },
  channels: {
    table: "public.lab_batch_channels_v1",
    columns: [
      "namespace:text:true",
      "channel_id:text:true",
      "record:jsonb:true",
    ],
    constraints: [
      "CHECK ((channel_id ~ '^0x[0-9a-f]{64}$'::text))",
      "CHECK ((namespace ~ '^[a-zA-Z0-9:_-]{1,128}$'::text))",
      "CHECK (((jsonb_typeof(record) = 'object'::text) AND (octet_length((record)::text) <= 32768)))",
      "PRIMARY KEY (namespace, channel_id)",
    ],
    grants: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  },
} as const;

/** Read-only PG16 readiness. Migration is a separate operator action.
 * This verifies this database, not ACLs on other cluster databases. Deployment
 * must additionally qualify a dedicated login against production boundaries.
 * A stock provider role inheriting cluster-wide access is intentionally refused.
 */
export async function assertBatchSchemaReady(
  pool: Pool,
  kind: keyof typeof schemas,
): Promise<void> {
  const expected = schemas[kind];
  const result = await pool.query(
    `SELECT
    current_database() AS database_name,
    current_user = session_user AS direct_login,
    NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS ordinary_role,
    NOT EXISTS (SELECT 1 FROM pg_roles other WHERE other.oid <> r.oid AND pg_has_role(current_user, other.oid, 'MEMBER')) AS no_memberships,
    NOT pg_has_role(current_user, d.datdba, 'MEMBER') AS not_database_owner,
    NOT has_database_privilege(current_user, current_database(), 'CREATE') AS no_database_create,
    NOT has_database_privilege(current_user, current_database(), 'TEMP') AS no_temporary_tables,
    has_schema_privilege(current_user, 'public', 'USAGE') AND NOT has_schema_privilege(current_user, 'public', 'CREATE') AS schema_access,
    NOT pg_is_in_recovery() AND current_setting('fsync') = 'on' AND current_setting('full_page_writes') = 'on'
      AND current_setting('synchronous_commit') = 'on' AS durable_primary,
    c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT pg_has_role(current_user, c.relowner, 'MEMBER') AS ordinary_table,
    ARRAY(SELECT a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text
      FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
    ARRAY(SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.conrelid = c.oid ORDER BY pg_get_constraintdef(k.oid)) AS constraints,
    NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND (NOT k.convalidated OR k.condeferrable)) AS immediate_constraints,
    NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS no_user_triggers,
    NOT EXISTS (SELECT 1 FROM pg_rewrite w WHERE w.ev_class = c.oid) AS no_rules,
    ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
      WHERE has_table_privilege(current_user, c.oid, privilege) ORDER BY privilege) AS grants
    FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
    LEFT JOIN pg_class c ON c.oid = to_regclass($1)
    WHERE r.rolname = current_user`,
    [expected.table],
  );
  const row = result.rows[0];
  const flags = [
    "direct_login",
    "ordinary_role",
    "no_memberships",
    "not_database_owner",
    "no_database_create",
    "no_temporary_tables",
    "schema_access",
    "durable_primary",
    "ordinary_table",
    "immediate_constraints",
    "no_user_triggers",
    "no_rules",
  ];
  const same = (a: unknown, b: readonly string[]) =>
    JSON.stringify(a) === JSON.stringify(b);
  if (
    !row ||
    !/^lab_batch_[a-z0-9_]+$/.test(row.database_name) ||
    flags.some((flag) => row[flag] !== true) ||
    !same(row.columns, expected.columns) ||
    !same(row.constraints, [...expected.constraints].sort()) ||
    !same(row.grants, [...expected.grants].sort())
  ) {
    throw new Error("batch database runtime schema or privileges refused");
  }
}
