import { createClient } from "npm:@pgkit/client";
import { Migration } from "npm:@pgkit/migra";

const clientBase = createClient(Deno.env.get("SOURCE"));
const clientHead = createClient(Deno.env.get("TARGET"));
const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");

const managedSchemas = ["auth", "realtime", "storage"];
const extensionSchemas = [
  "pg_catalog",
  "extensions",
  "pgmq",
  "tiger",
  "topology",
];
const excludedSchemas = [
  ...(Deno.env.get("EXCLUDED_SCHEMAS") ?? "").split(","),
  ...extensionSchemas,
  ...managedSchemas,
  // Owned by extensions
  "cron",
  "graphql",
  "graphql_public",
  "net",
  "pgroonga",
  "pgtle",
  "repack",
  "tiger_data",
  "vault",
  // Deprecated extensions
  "pgsodium",
  "pgsodium_masks",
  "timescaledb_experimental",
  "timescaledb_information",
  "_timescaledb_cache",
  "_timescaledb_catalog",
  "_timescaledb_config",
  "_timescaledb_debug",
  "_timescaledb_functions",
  "_timescaledb_internal",
  // Managed by Supabase
  "pgbouncer",
  "supabase_functions",
  "supabase_migrations",
];

try {
  let sql = "";
  if (includedSchemas) {
    for (const schema of includedSchemas.split(",")) {
      const m = await Migration.create(clientBase, clientHead, {
        schema,
        ignore_extension_versions: true,
      });
      m.set_safety(false);
      m.add_all_changes(true);
      sql += m.sql;
    }
  } else {
    // Migra does not ignore custom types and triggers created by extensions, so we diff
    // them separately. This workaround only applies to a known list of managed schemas.
    for (const schema of extensionSchemas) {
      const e = await Migration.create(clientBase, clientHead, {
        schema,
        ignore_extension_versions: true,
      });
      e.set_safety(false);
      e.add(e.changes.schemas({ creations_only: true }));
      e.add_extension_changes();
      sql += e.sql;
    }
    // Diff user defined entities in non-managed schemas, including extensions.
    const m = await Migration.create(clientBase, clientHead, {
      exclude_schema: excludedSchemas,
      ignore_extension_versions: true,
    });
    m.set_safety(false);
    m.add_all_changes(true);
    sql += m.sql;
    // For managed schemas, we want to include triggers and RLS policies only.
    for (const schema of managedSchemas) {
      const s = await Migration.create(clientBase, clientHead, {
        schema,
        ignore_extension_versions: true,
      });
      s.set_safety(false);
      s.add(s.changes.triggers({ drops_only: true }));
      s.add(s.changes.rlspolicies({ drops_only: true }));
      s.add(s.changes.rlspolicies({ creations_only: true }));
      s.add(s.changes.triggers({ creations_only: true }));
      sql += s.sql;
    }
  }
  console.log(sql);
} catch (e) {
  console.error(e);
} finally {
  await Promise.all([clientHead.end(), clientBase.end()]);
}
