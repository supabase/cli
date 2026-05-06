import { createClient, sql } from "npm:@pgkit/client";
import { Migration } from "npm:@pgkit/migra";

// Avoids error on self-signed certificate
const ca = Deno.env.get("SSL_CA");
const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");
const sslDebug = Deno.env.get("SUPABASE_SSL_DEBUG")?.toLowerCase() === "true";

function redactPostgresUrl(raw: string | undefined): string {
  if (!raw) return "<unset>";
  try {
    const u = new URL(raw);
    if (u.password) u.password = "xxxxx";
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

if (sslDebug) {
  console.error(
    `[ssl-debug] migra.ts deno=${Deno.version.deno} v8=${Deno.version.v8} os=${Deno.build.os}`,
  );
  console.error(
    `[ssl-debug] migra.ts source=${redactPostgresUrl(source)} target=${redactPostgresUrl(target)}`,
  );
  console.error(
    `[ssl-debug] migra.ts ssl_ca_set=${ca != null} ssl_ca_len=${ca?.length ?? 0}`,
  );
}

const clientBase = createClient(source);
const clientHead = createClient(target, {
  pgpOptions: { connect: { ssl: ca && { ca } } },
});
const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS")?.split(",") ?? [];
const excludedSchemas = Deno.env.get("EXCLUDED_SCHEMAS")?.split(",") ?? [];

const managedSchemas = ["auth", "realtime", "storage"];
const extensionSchemas = [
  "pg_catalog",
  "extensions",
  "pgmq",
  "tiger",
  "topology",
];

try {
  // Step down from login role to postgres
  await clientHead.query(sql`set role postgres`);
  // Force schema qualified references for pg_get_expr
  await clientHead.query(sql`set search_path = ''`);
  await clientBase.query(sql`set search_path = ''`);
  const result: string[] = [];
  for (const schema of includedSchemas) {
    const m = await Migration.create(clientBase, clientHead, {
      schema,
      ignore_extension_versions: true,
    });
    m.set_safety(false);
    if (managedSchemas.includes(schema)) {
      m.add(m.changes.triggers({ drops_only: true }));
      m.add(m.changes.rlspolicies({ drops_only: true }));
      m.add(m.changes.rlspolicies({ creations_only: true }));
      m.add(m.changes.triggers({ creations_only: true }));
    } else {
      m.add_all_changes(true);
    }
    result.push(m.sql);
  }
  if (includedSchemas.length === 0) {
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
      result.push(e.sql);
    }
    // Diff user defined entities in non-managed schemas, including extensions.
    const m = await Migration.create(clientBase, clientHead, {
      exclude_schema: [
        ...managedSchemas,
        ...extensionSchemas,
        ...excludedSchemas,
      ],
      ignore_extension_versions: true,
    });
    m.set_safety(false);
    m.add_all_changes(true);
    result.push(m.sql);
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
      result.push(s.sql);
    }
  }
  console.log(result.join(""));
} catch (e) {
  if (sslDebug) {
    if (e instanceof Error) {
      console.error(
        `[ssl-debug] migra.ts error_name=${e.name} message=${e.message} stack=${e.stack ?? "<none>"}`,
      );
    } else {
      console.error(`[ssl-debug] migra.ts error=${String(e)}`);
    }
  }
  console.error(e);
} finally {
  await Promise.all([clientHead.end(), clientBase.end()]);
}
