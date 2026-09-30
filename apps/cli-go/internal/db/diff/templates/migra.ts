import { createClient } from "npm:@pgkit/client";
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

type PoolClient = {
  query: (stmt: string) => Promise<unknown>;
  on: (event: "error", listener: () => void) => void;
  off: (event: "error", listener: () => void) => void;
};
// Step down from login role to postgres and force schema qualified references for
// pg_get_expr on every pooled connection, including one reopened after an idle timeout
const verify = (stmt: string) => (client: PoolClient, done: (err?: Error) => void) => {
  // pg-pool drops its error listener during verify, so a socket error must reject, not throw
  const ignore = () => {};
  client.on("error", ignore);
  client
    .query(stmt)
    .finally(() => client.off("error", ignore))
    .then(
      () => done(),
      (err: Error) => {
        err.message = `${stmt}: ${err.message}`;
        done(err);
      },
    );
};
const clientBase = createClient(source, {
  pgpOptions: { connect: { verify: verify("set search_path = ''") } },
});
const clientHead = createClient(target, {
  pgpOptions: {
    connect: {
      ssl: ca && { ca },
      verify: verify("set role postgres; set search_path = ''"),
    },
  },
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
  console.error("PGDELTA_SCRIPT_ERROR");
} finally {
  await Promise.all([clientHead.end(), clientBase.end()]);
}
