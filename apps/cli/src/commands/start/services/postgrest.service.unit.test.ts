import { describe, expect, test } from "vitest";

import {
  legacyBuildPostgrestContainerSpec,
  legacyBuildPostgrestEnv,
  type LegacyPostgrestContainerSpecInput,
} from "./postgrest.service.ts";

describe("legacyBuildPostgrestEnv", () => {
  const base = {
    schemas: ["public", "graphql_public"],
    extraSearchPath: ["public", "extensions"],
    maxRows: 1000,
    dbHost: "supabase_db_proj",
    dbPassword: "postgres",
    jwks: '{"keys":[]}',
  };

  test("wires PGRST_DB_URI as the authenticator role against the internal DB address", () => {
    const env = legacyBuildPostgrestEnv(base);
    expect(env["PGRST_DB_URI"]).toBe(
      "postgresql://authenticator:postgres@supabase_db_proj:5432/postgres",
    );
  });

  test("joins schemas and extra_search_path with commas", () => {
    const env = legacyBuildPostgrestEnv(base);
    expect(env["PGRST_DB_SCHEMAS"]).toBe("public,graphql_public");
    expect(env["PGRST_DB_EXTRA_SEARCH_PATH"]).toBe("public,extensions");
  });

  test("feeds the resolved JWKS string into PGRST_JWT_SECRET, not the raw jwt secret", () => {
    const env = legacyBuildPostgrestEnv({ ...base, jwks: '{"keys":["fake"]}' });
    expect(env["PGRST_JWT_SECRET"]).toBe('{"keys":["fake"]}');
  });

  test("matches Go's remaining static env values", () => {
    const env = legacyBuildPostgrestEnv(base);
    expect(env).toMatchObject({
      PGRST_DB_MAX_ROWS: "1000",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_ADMIN_SERVER_PORT: "3001",
    });
  });
});

describe("legacyBuildPostgrestContainerSpec", () => {
  const input: LegacyPostgrestContainerSpecInput = {
    projectId: "proj",
    networkId: "supabase_network_proj",
    image: "supabase/postgrest:v12",
    schemas: ["public"],
    extraSearchPath: ["public"],
    maxRows: 1000,
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    jwks: '{"keys":[]}',
  };

  test("derives the container name and internal DB host from projectId", () => {
    const spec = legacyBuildPostgrestContainerSpec(input);
    expect(spec.containerName).toBe("supabase_rest_proj");
    expect(spec.env["PGRST_DB_URI"]).toBe(
      "postgresql://authenticator:postgres@supabase_db_proj:5432/postgres",
    );
  });

  test("has no healthcheck, no ports, and no exposedPorts — matching Go's PostgREST container.Config", () => {
    const spec = legacyBuildPostgrestContainerSpec(input);
    expect(spec.healthcheck).toBeUndefined();
    expect(spec.ports).toBeUndefined();
    expect(spec.exposedPorts).toBeUndefined();
  });

  test("network alias is 'rest'", () => {
    const spec = legacyBuildPostgrestContainerSpec(input);
    expect(spec.networkAliases).toEqual(["rest"]);
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.labels).toEqual({});
  });

  test("reuses (does not recompute) the resolved db password from a non-default dbUrl", () => {
    const spec = legacyBuildPostgrestContainerSpec({
      ...input,
      dbUrl: "postgresql://postgres:another-secret@127.0.0.1:54322/postgres",
    });
    expect(spec.env["PGRST_DB_URI"]).toBe(
      "postgresql://authenticator:another-secret@supabase_db_proj:5432/postgres",
    );
  });
});
