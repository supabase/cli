import { describe, expect, test } from "vitest";

import {
  legacyBuildSupavisorContainerSpec,
  legacyBuildSupavisorStartCmd,
  type LegacySupavisorContainerSpecInput,
} from "./supavisor.service.ts";

const base: LegacySupavisorContainerSpecInput = {
  image: "supabase/supavisor:2.0.0",
  projectId: "proj",
  networkId: "supabase_network_proj",
  port: 54329,
  poolMode: "transaction",
  defaultPoolSize: 20,
  maxClientConn: 100,
  jwtSecret: "jwt-secret",
  dbHost: "supabase_db_proj",
  dbPort: 5432,
  dbUser: "postgres",
  dbPassword: "secret",
  dbDatabase: "postgres",
};

describe("legacyBuildSupavisorStartCmd", () => {
  test("reads the tenant script from the fixed secretFiles path and evals its content, never embedding it inline (CWE-214/522)", () => {
    expect(legacyBuildSupavisorStartCmd()).toEqual([
      "/bin/sh",
      "-c",
      '/app/bin/migrate && /app/bin/supavisor eval "$(cat /app/pooler_tenant.exs)" && /app/bin/server',
    ]);
  });
});

describe("legacyBuildSupavisorContainerSpec", () => {
  test("Cmd only ever references the fixed /app/pooler_tenant.exs path, with no Entrypoint override (start.go:1201-1237)", () => {
    const spec = legacyBuildSupavisorContainerSpec(base);
    expect(spec.entrypoint).toBeUndefined();
    expect(spec.cmd).toEqual([
      "/bin/sh",
      "-c",
      '/app/bin/migrate && /app/bin/supavisor eval "$(cat /app/pooler_tenant.exs)" && /app/bin/server',
    ]);
  });

  test("carries the rendered pooler.exs tenant script as a secretFile bind-mounted at /app/pooler_tenant.exs, not a post-start docker exec (start.go:1201-1237)", () => {
    const spec = legacyBuildSupavisorContainerSpec(base);
    expect(spec.secretFiles).toHaveLength(1);
    const tenantFile = spec.secretFiles?.[0];
    expect(tenantFile?.containerPath).toBe("/app/pooler_tenant.exs");
    const script = tenantFile?.content ?? "";
    expect(script).toContain('"db_host" => "supabase_db_proj"');
    expect(script).toContain('"db_port" => 5432');
    expect(script).toContain('"db_database" => "postgres"');
    expect(script).toContain('"db_password" => "secret"');
    expect(script).toContain('"mode_type" => "transaction"');
    expect(script).toContain('"default_max_clients" => 100');
    expect(script).toContain('"default_pool_size" => 20');
  });

  test("never leaks the tenant script (db_password included) into Cmd itself", () => {
    const spec = legacyBuildSupavisorContainerSpec(base);
    const cmdText = (spec.cmd ?? []).join(" ");
    expect(cmdText).not.toContain("secret");
    expect(cmdText).not.toContain("db_password");
  });

  test("uses the hardcoded pooler-dev tenant id, not a config-supplied value (config.go:465)", () => {
    const spec = legacyBuildSupavisorContainerSpec(base);
    expect(spec.secretFiles?.[0]?.content).toContain('"external_id" => "pooler-dev"');
  });

  test("binds the transaction port (6543) to the host when pool_mode is transaction (start.go:1194-1200)", () => {
    const spec = legacyBuildSupavisorContainerSpec({ ...base, poolMode: "transaction" });
    expect(spec.ports).toEqual([{ hostPort: "54329", containerPort: "6543" }]);
    expect(spec.exposedPorts).toEqual([
      { containerPort: "4000" },
      { containerPort: "5432" },
      { containerPort: "6543" },
    ]);
  });

  test("binds the session port (5432) to the host when pool_mode is session (start.go:1198-1199)", () => {
    const spec = legacyBuildSupavisorContainerSpec({ ...base, poolMode: "session" });
    expect(spec.ports).toEqual([{ hostPort: "54329", containerPort: "5432" }]);
  });

  test("sets the hardcoded local-dev secrets and both JWT env vars (start.go:1219-1232)", () => {
    const spec = legacyBuildSupavisorContainerSpec(base);
    expect(spec.env).toMatchObject({
      PORT: "4000",
      PROXY_PORT_SESSION: "5432",
      PROXY_PORT_TRANSACTION: "6543",
      DATABASE_URL: "ecto://postgres:secret@supabase_db_proj:5432/_supabase",
      CLUSTER_POSTGRES: "true",
      SECRET_KEY_BASE: "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
      VAULT_ENC_KEY: "12345678901234567890123456789032",
      API_JWT_SECRET: "jwt-secret",
      METRICS_JWT_SECRET: "jwt-secret",
      REGION: "local",
      RUN_JANITOR: "true",
      ERL_AFLAGS: "-proto_dist inet_tcp",
      RLIMIT_NOFILE: "",
    });
  });

  test("builds the remaining identity/network fields (start.go:1215-1263)", () => {
    const spec = legacyBuildSupavisorContainerSpec(base);
    expect(spec.image).toBe("supabase/supavisor:2.0.0");
    expect(spec.containerName).toBe("supabase_pooler_proj");
    expect(spec.binds).toEqual([]);
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD",
        "curl",
        "-sSfL",
        "--head",
        "-o",
        "/dev/null",
        "http://127.0.0.1:4000/api/health",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.networkAliases).toEqual(["pooler"]);
  });

  test("uses wget --spider on slim images", () => {
    const spec = legacyBuildSupavisorContainerSpec({
      ...base,
      image: "ghcr.io/supabase/cli/pooler:v2.9.10",
    });
    expect(spec.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "--spider",
      "http://127.0.0.1:4000/api/health",
    ]);
  });
});
