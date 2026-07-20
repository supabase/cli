import { describe, expect, test } from "vitest";

import { legacyBuildPgMetaContainerSpec } from "./pg-meta.service.ts";

describe("legacyBuildPgMetaContainerSpec", () => {
  test("assembles the full container spec from resolved inputs", () => {
    const spec = legacyBuildPgMetaContainerSpec({
      image: "supabase/postgres-meta:v0.96.6",
      containerName: "supabase_pg_meta_proj",
      dbHost: "supabase_db_proj",
      dbPort: 5432,
      dbUser: "postgres",
      dbPassword: "postgres",
      dbName: "postgres",
      networkId: "supabase_network_proj",
    });

    expect(spec).toEqual({
      image: "supabase/postgres-meta:v0.96.6",
      containerName: "supabase_pg_meta_proj",
      env: {
        PG_META_PORT: "8080",
        PG_META_DB_HOST: "supabase_db_proj",
        PG_META_DB_NAME: "postgres",
        PG_META_DB_USER: "postgres",
        PG_META_DB_PORT: "5432",
        PG_META_DB_PASSWORD: "postgres",
      },
      binds: [],
      healthcheck: {
        test: [
          "CMD-SHELL",
          `node --eval="fetch('http://127.0.0.1:8080/health').then((r) => {if (!r.ok) throw new Error(r.status)})"`,
        ],
        intervalSeconds: 10,
        timeoutSeconds: 2,
        retries: 3,
      },
      restartPolicy: "unless-stopped",
      networkId: "supabase_network_proj",
      networkAliases: ["pg_meta"],
      labels: {},
    });
  });

  test("reflects a non-default db host/port/password in env, while the healthcheck stays on the fixed container port", () => {
    const spec = legacyBuildPgMetaContainerSpec({
      image: "supabase/postgres-meta:v0.96.6",
      containerName: "supabase_pg_meta_proj",
      dbHost: "custom-db-host",
      dbPort: 6543,
      dbUser: "postgres",
      dbPassword: "hunter2",
      dbName: "postgres",
      networkId: "supabase_network_proj",
    });

    expect(spec.env["PG_META_DB_HOST"]).toBe("custom-db-host");
    expect(spec.env["PG_META_DB_PORT"]).toBe("6543");
    expect(spec.env["PG_META_DB_PASSWORD"]).toBe("hunter2");
    expect(spec.healthcheck?.test[1]).toContain("127.0.0.1:8080");
  });
});
