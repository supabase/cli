import { describe, expect, it } from "vitest";

import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "./legacy-inspect-schemas.ts";

describe("legacyLikeEscapeSchema", () => {
  it("escapes underscores as literals and stars as the any-character wildcard", () => {
    expect(legacyLikeEscapeSchema(["pg_*"])).toEqual(["pg\\_%"]);
    expect(legacyLikeEscapeSchema(["_timescaledb_*"])).toEqual(["\\_timescaledb\\_%"]);
    expect(legacyLikeEscapeSchema(["timescaledb_*"])).toEqual(["timescaledb\\_%"]);
    expect(legacyLikeEscapeSchema(["supabase_functions"])).toEqual(["supabase\\_functions"]);
  });

  it("leaves a plain schema name untouched", () => {
    expect(legacyLikeEscapeSchema(["auth"])).toEqual(["auth"]);
  });

  it("escapes the full internal-schema set", () => {
    const escaped = legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS);
    expect(escaped).toHaveLength(LEGACY_INTERNAL_SCHEMAS.length);
    // No raw `_` or `*` survives; every original `_` becomes `\_` and `*` becomes `%`.
    for (const pattern of escaped) {
      expect(pattern).not.toMatch(/\*/);
      expect(pattern).not.toMatch(/(?<!\\)_/);
    }
  });
});

describe("LEGACY_INTERNAL_SCHEMAS", () => {
  it("matches the Go `utils.InternalSchemas` list (29 entries, in order)", () => {
    expect(LEGACY_INTERNAL_SCHEMAS).toEqual([
      "information_schema",
      "pg_*",
      "_analytics",
      "_realtime",
      "_supavisor",
      "auth",
      "etl",
      "extensions",
      "pgbouncer",
      "realtime",
      "storage",
      "supabase_functions",
      "supabase_migrations",
      "cron",
      "dbdev",
      "graphql",
      "graphql_public",
      "net",
      "pgmq",
      "pgsodium",
      "pgsodium_masks",
      "pgtle",
      "repack",
      "tiger",
      "tiger_data",
      "timescaledb_*",
      "_timescaledb_*",
      "topology",
      "vault",
    ]);
  });
});
