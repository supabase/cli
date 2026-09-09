import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { PgConnInput } from "./db-connection.service.ts";
import {
  ALLOWED_CONFIGS,
  EXCLUDED_SCHEMAS,
  INTERNAL_SCHEMAS,
  RESERVED_ROLES,
  buildDataDumpEnv,
  buildRoleDumpEnv,
  buildSchemaDumpEnv,
  expandScript,
  quoteUpperCase,
  toDumpEnv,
  type DumpOptions,
} from "./pg-dump.env.ts";
import { dumpDataScript, dumpRoleScript, dumpSchemaScript } from "./pg-dump.scripts.ts";

const CONN: PgConnInput = {
  host: "db.example.supabase.co",
  port: 5432,
  user: "postgres",
  password: 'p"a"ss',
  database: "postgres",
};

const baseOpt: DumpOptions = {
  schema: [],
  keepComments: false,
  excludeTable: [],
  columnInsert: true,
};

// Resolve the Go `.sh` sources relative to this file so the byte-equality
// assertion fails loudly if the embedded copies drift from upstream.
const goScriptsDir = fileURLToPath(
  new URL("../../../cli-go/pkg/migration/scripts/", import.meta.url),
);
const readGoScript = (name: string) => readFileSync(`${goScriptsDir}${name}`, "utf8");

describe("toDumpEnv", () => {
  it("maps the connection to PG* env vars (port stringified)", () => {
    expect(toDumpEnv(CONN)).toEqual({
      PGHOST: "db.example.supabase.co",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: 'p"a"ss',
      PGDATABASE: "postgres",
    });
  });
});

describe("buildSchemaDumpEnv", () => {
  it("excludes the internal schemas by default and strips comments", () => {
    const env = buildSchemaDumpEnv(CONN, baseOpt);
    expect(env["EXCLUDED_SCHEMAS"]).toBe(INTERNAL_SCHEMAS.join("|"));
    expect(env["EXTRA_FLAGS"]).toBeUndefined();
    expect(env["EXTRA_SED"]).toBe("/^--/d");
  });

  it("includes only the requested schemas via --schema and keeps comments", () => {
    const env = buildSchemaDumpEnv(CONN, {
      ...baseOpt,
      schema: ["public", "auth"],
      keepComments: true,
    });
    expect(env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    expect(env["EXCLUDED_SCHEMAS"]).toBeUndefined();
    expect(env["EXTRA_SED"]).toBeUndefined();
  });
});

describe("buildDataDumpEnv", () => {
  it("includes all schemas and excludes the platform schemas by default", () => {
    const env = buildDataDumpEnv(CONN, baseOpt);
    expect(env["INCLUDED_SCHEMAS"]).toBe("*");
    expect(env["EXCLUDED_SCHEMAS"]).toBe(EXCLUDED_SCHEMAS.join("|"));
    expect(env["EXTRA_FLAGS"]).toBe("--column-inserts --rows-per-insert 100000");
  });

  it("omits column-insert flags when --use-copy is set (columnInsert false)", () => {
    const env = buildDataDumpEnv(CONN, { ...baseOpt, columnInsert: false });
    expect(env["EXTRA_FLAGS"]).toBeUndefined();
  });

  it("limits to selected schemas and appends quoted --exclude-table flags", () => {
    const env = buildDataDumpEnv(CONN, {
      ...baseOpt,
      schema: ["public"],
      excludeTable: ["public.users", "auth.sessions"],
    });
    expect(env["INCLUDED_SCHEMAS"]).toBe("public");
    expect(env["EXCLUDED_SCHEMAS"]).toBeUndefined();
    expect(env["EXTRA_FLAGS"]).toBe(
      '--column-inserts --rows-per-insert 100000 --exclude-table "public"."users" --exclude-table "auth"."sessions"',
    );
  });
});

describe("quoteUpperCase", () => {
  it("quotes each dotted component", () => {
    expect(quoteUpperCase("public.users")).toBe('"public"."users"');
    expect(quoteUpperCase("users")).toBe('"users"');
  });
});

describe("buildRoleDumpEnv", () => {
  it("sets the reserved-roles and allowed-configs lists verbatim", () => {
    const env = buildRoleDumpEnv(CONN, baseOpt);
    expect(env["RESERVED_ROLES"]).toBe(RESERVED_ROLES.join("|"));
    expect(env["ALLOWED_CONFIGS"]).toBe(ALLOWED_CONFIGS.join("|"));
    expect(env["EXTRA_SED"]).toBe("/^--/d");
  });

  it("keeps comments (no EXTRA_SED) when keepComments is true", () => {
    const env = buildRoleDumpEnv(CONN, { ...baseOpt, keepComments: true });
    expect(env["EXTRA_SED"]).toBeUndefined();
  });
});

describe("expandScript", () => {
  it("expands $VAR and ${VAR} forms, ignoring bash defaults", () => {
    const env = { PGHOST: "myhost", EXCLUDED_SCHEMAS: "auth|storage" };
    expect(expandScript('host=$PGHOST excl="${EXCLUDED_SCHEMAS:-}"', env)).toBe(
      'host=myhost excl="auth|storage"',
    );
  });

  it("escapes double quotes in substituted values", () => {
    expect(expandScript("pw=$PGPASSWORD", { PGPASSWORD: 'a"b' })).toBe('pw=a\\"b');
  });

  it("treats an unset variable as empty", () => {
    expect(expandScript("x=${MISSING:-}", {})).toBe("x=");
  });

  it("preserves a $ that is not followed by a name (e.g. a regex end anchor)", () => {
    // `.*$/` must survive intact — the `$` precedes `/`, which is not a var name.
    expect(expandScript("s/^x.*$/-- &/", {})).toBe("s/^x.*$/-- &/");
  });

  it("expands an embedded schema reference inside a sed pattern", () => {
    const out = expandScript('"(${EXCLUDED_SCHEMAS:-})"', { EXCLUDED_SCHEMAS: "auth" });
    expect(out).toBe('"(auth)"');
  });
});

describe("embedded dump scripts", () => {
  it("match the Go sources byte-for-byte", () => {
    expect(dumpSchemaScript).toBe(readGoScript("dump_schema.sh"));
    expect(dumpDataScript).toBe(readGoScript("dump_data.sh"));
    expect(dumpRoleScript).toBe(readGoScript("dump_role.sh"));
  });
});
