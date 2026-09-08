import { describe, expect, it } from "vitest";

import { INTERNAL_SCHEMAS, likeEscapeSchema } from "./inspect-schemas.ts";

describe("likeEscapeSchema", () => {
  it("escapes underscores as literals and stars as the any-character wildcard", () => {
    expect(likeEscapeSchema(["pg_*"])).toEqual(["pg\\_%"]);
    expect(likeEscapeSchema(["_timescaledb_*"])).toEqual(["\\_timescaledb\\_%"]);
    expect(likeEscapeSchema(["timescaledb_*"])).toEqual(["timescaledb\\_%"]);
    expect(likeEscapeSchema(["supabase_functions"])).toEqual(["supabase\\_functions"]);
  });

  it("escapes backslashes before LIKE metacharacters", () => {
    expect(likeEscapeSchema([String.raw`custom\schema`])).toEqual([String.raw`custom\\schema`]);
    expect(likeEscapeSchema([String.raw`custom\_schema`])).toEqual([String.raw`custom\\\_schema`]);
  });

  it("leaves a plain schema name untouched", () => {
    expect(likeEscapeSchema(["auth"])).toEqual(["auth"]);
  });

  it("escapes the full internal-schema set", () => {
    const escaped = likeEscapeSchema(INTERNAL_SCHEMAS);
    expect(escaped).toHaveLength(INTERNAL_SCHEMAS.length);
    // No raw `_` or `*` survives; every original `_` becomes `\_` and `*` becomes `%`.
    for (const pattern of escaped) {
      expect(pattern).not.toMatch(/\*/);
      expect(pattern).not.toMatch(/(?<!\\)_/);
    }
  });
});

describe("INTERNAL_SCHEMAS", () => {
  it("matches the Go `utils.InternalSchemas` list (29 entries, in order)", () => {
    expect(INTERNAL_SCHEMAS).toEqual([
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
