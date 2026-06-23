import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import {
  LEGACY_ALLOWED_CONFIGS,
  LEGACY_EXCLUDED_SCHEMAS,
  LEGACY_INTERNAL_SCHEMAS,
  LEGACY_RESERVED_ROLES,
  legacyBuildDataDumpEnv,
  legacyBuildRoleDumpEnv,
  legacyBuildSchemaDumpEnv,
  legacyExpandScript,
  legacyQuoteUpperCase,
  legacyToDumpEnv,
  type LegacyDumpOptions,
} from "./dump.env.ts";
import {
  legacyDumpDataScript,
  legacyDumpRoleScript,
  legacyDumpSchemaScript,
} from "./dump.scripts.ts";

const CONN: LegacyPgConnInput = {
  host: "db.example.supabase.co",
  port: 5432,
  user: "postgres",
  password: 'p"a"ss',
  database: "postgres",
};

const baseOpt: LegacyDumpOptions = {
  schema: [],
  keepComments: false,
  excludeTable: [],
  columnInsert: true,
};

// Resolve the Go `.sh` sources relative to this file so the byte-equality
// assertion fails loudly if the embedded copies drift from upstream.
const goScriptsDir = fileURLToPath(
  new URL("../../../../../../cli-go/pkg/migration/scripts/", import.meta.url),
);
const readGoScript = (name: string) => readFileSync(`${goScriptsDir}${name}`, "utf8");

describe("legacyToDumpEnv", () => {
  it("maps the connection to PG* env vars (port stringified)", () => {
    expect(legacyToDumpEnv(CONN)).toEqual({
      PGHOST: "db.example.supabase.co",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: 'p"a"ss',
      PGDATABASE: "postgres",
    });
  });
});

describe("legacyBuildSchemaDumpEnv", () => {
  it("excludes the internal schemas by default and strips comments", () => {
    const env = legacyBuildSchemaDumpEnv(CONN, baseOpt);
    expect(env["EXCLUDED_SCHEMAS"]).toBe(LEGACY_INTERNAL_SCHEMAS.join("|"));
    expect(env["EXTRA_FLAGS"]).toBeUndefined();
    expect(env["EXTRA_SED"]).toBe("/^--/d");
  });

  it("includes only the requested schemas via --schema and keeps comments", () => {
    const env = legacyBuildSchemaDumpEnv(CONN, {
      ...baseOpt,
      schema: ["public", "auth"],
      keepComments: true,
    });
    expect(env["EXTRA_FLAGS"]).toBe("--schema=public|auth");
    expect(env["EXCLUDED_SCHEMAS"]).toBeUndefined();
    expect(env["EXTRA_SED"]).toBeUndefined();
  });
});

describe("legacyBuildDataDumpEnv", () => {
  it("includes all schemas and excludes the platform schemas by default", () => {
    const env = legacyBuildDataDumpEnv(CONN, baseOpt);
    expect(env["INCLUDED_SCHEMAS"]).toBe("*");
    expect(env["EXCLUDED_SCHEMAS"]).toBe(LEGACY_EXCLUDED_SCHEMAS.join("|"));
    expect(env["EXTRA_FLAGS"]).toBe("--column-inserts --rows-per-insert 100000");
  });

  it("omits column-insert flags when --use-copy is set (columnInsert false)", () => {
    const env = legacyBuildDataDumpEnv(CONN, { ...baseOpt, columnInsert: false });
    expect(env["EXTRA_FLAGS"]).toBeUndefined();
  });

  it("limits to selected schemas and appends quoted --exclude-table flags", () => {
    const env = legacyBuildDataDumpEnv(CONN, {
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

describe("legacyQuoteUpperCase", () => {
  it("quotes each dotted component", () => {
    expect(legacyQuoteUpperCase("public.users")).toBe('"public"."users"');
    expect(legacyQuoteUpperCase("users")).toBe('"users"');
  });
});

describe("legacyBuildRoleDumpEnv", () => {
  it("sets the reserved-roles and allowed-configs lists verbatim", () => {
    const env = legacyBuildRoleDumpEnv(CONN, baseOpt);
    expect(env["RESERVED_ROLES"]).toBe(LEGACY_RESERVED_ROLES.join("|"));
    expect(env["ALLOWED_CONFIGS"]).toBe(LEGACY_ALLOWED_CONFIGS.join("|"));
    expect(env["EXTRA_SED"]).toBe("/^--/d");
  });

  it("keeps comments (no EXTRA_SED) when keepComments is true", () => {
    const env = legacyBuildRoleDumpEnv(CONN, { ...baseOpt, keepComments: true });
    expect(env["EXTRA_SED"]).toBeUndefined();
  });
});

describe("legacyExpandScript", () => {
  it("expands $VAR and ${VAR} forms, ignoring bash defaults", () => {
    const env = { PGHOST: "myhost", EXCLUDED_SCHEMAS: "auth|storage" };
    expect(legacyExpandScript('host=$PGHOST excl="${EXCLUDED_SCHEMAS:-}"', env)).toBe(
      'host=myhost excl="auth|storage"',
    );
  });

  it("escapes double quotes in substituted values", () => {
    expect(legacyExpandScript("pw=$PGPASSWORD", { PGPASSWORD: 'a"b' })).toBe('pw=a\\"b');
  });

  it("treats an unset variable as empty", () => {
    expect(legacyExpandScript("x=${MISSING:-}", {})).toBe("x=");
  });

  it("preserves a $ that is not followed by a name (e.g. a regex end anchor)", () => {
    // `.*$/` must survive intact — the `$` precedes `/`, which is not a var name.
    expect(legacyExpandScript("s/^x.*$/-- &/", {})).toBe("s/^x.*$/-- &/");
  });

  it("expands an embedded schema reference inside a sed pattern", () => {
    const out = legacyExpandScript('"(${EXCLUDED_SCHEMAS:-})"', { EXCLUDED_SCHEMAS: "auth" });
    expect(out).toBe('"(auth)"');
  });
});

describe("embedded dump scripts", () => {
  it("match the Go sources byte-for-byte", () => {
    expect(legacyDumpSchemaScript).toBe(readGoScript("dump_schema.sh"));
    expect(legacyDumpDataScript).toBe(readGoScript("dump_data.sh"));
    expect(legacyDumpRoleScript).toBe(readGoScript("dump_role.sh"));
  });
});
