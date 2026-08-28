import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  legacyBuildLogflareContainerSpec,
  type LegacyLogflareContainerSpecInput,
} from "./logflare.service.ts";

const base: LegacyLogflareContainerSpecInput = {
  image: "supabase/logflare:1.0.0",
  projectId: "proj",
  networkId: "supabase_network_proj",
  port: 54327,
  backend: "postgres",
  gcpProjectId: "",
  gcpProjectNumber: "",
  gcpJwtPath: "",
  workdir: "/workdir",
  dbHost: "supabase_db_proj",
  dbPort: 5432,
  dbUser: "postgres",
  dbPassword: "secret",
};

describe("legacyBuildLogflareContainerSpec", () => {
  test("builds the shared shape: identity, hostname, entrypoint/cmd, ports, healthcheck, aliases (start.go:350-394)", () => {
    const spec = legacyBuildLogflareContainerSpec(base);
    expect(spec.image).toBe("supabase/logflare:1.0.0");
    expect(spec.containerName).toBe("supabase_analytics_proj");
    expect(spec.hostname).toBe("127.0.0.1");
    expect(spec.entrypoint).toBe("sh");
    expect(spec.cmd).toEqual([
      "-c",
      "cat <<'EOF' > run.sh && exec sh run.sh\n" +
        "./logflare eval Logflare.Release.migrate || exit $?\n" +
        "./logflare start --sname logflare &\n" +
        "BEAM_PID=$!\n" +
        'trap \'kill -TERM "$BEAM_PID" 2>/dev/null; n=0; while [ "$n" -lt 3 ] && kill -0 "$BEAM_PID" 2>/dev/null; do n=$((n+1)); sleep 1; done; kill -KILL "$BEAM_PID" 2>/dev/null\' TERM\n' +
        'wait "$BEAM_PID"\n' +
        "code=$?\n" +
        'if [ "$code" -gt 128 ]; then wait "$BEAM_PID" 2>/dev/null; code2=$?; [ "$code2" -ne 127 ] && code=$code2; fi\n' +
        'exit "$code"\n' +
        "EOF\n",
    ]);
    expect(spec.exposedPorts).toEqual([{ containerPort: "4000" }]);
    expect(spec.ports).toEqual([{ hostPort: "54327", containerPort: "4000" }]);
    expect(spec.healthcheck).toEqual({
      test: ["CMD", "curl", "-sSfL", "--head", "-o", "/dev/null", "http://127.0.0.1:4000/health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
      startPeriodSeconds: 10,
    });
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.networkAliases).toEqual(["analytics"]);
    expect(spec.networkId).toBe("supabase_network_proj");
  });

  test("uses wget --spider on slim images and keeps the run.sh override", () => {
    const spec = legacyBuildLogflareContainerSpec({
      ...base,
      image: "ghcr.io/supabase/cli/analytics:v1.50.4",
    });
    expect(spec.entrypoint).toBe("sh");
    expect(spec.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "--spider",
      "http://127.0.0.1:4000/health",
    ]);
  });

  test("emits the common DB_*/LOGFLARE_* env vars regardless of backend (start.go:315-330)", () => {
    const spec = legacyBuildLogflareContainerSpec(base);
    expect(spec.env).toMatchObject({
      DB_DATABASE: "_supabase",
      DB_HOSTNAME: "supabase_db_proj",
      DB_PORT: "5432",
      DB_SCHEMA: "_analytics",
      DB_USERNAME: "supabase_admin",
      DB_PASSWORD: "secret",
      LOGFLARE_MIN_CLUSTER_SIZE: "1",
      LOGFLARE_SINGLE_TENANT: "true",
      LOGFLARE_SUPABASE_MODE: "true",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: "api-key",
      LOGFLARE_LOG_LEVEL: "warn",
      LOGFLARE_NODE_HOST: "127.0.0.1",
      LOGFLARE_FEATURE_FLAG_OVERRIDE: "'multibackend=true'",
      RELEASE_COOKIE: "cookie",
    });
  });

  test("postgres backend: sets POSTGRES_BACKEND_URL/SCHEMA, no GCP env or bind, no bind mounts (start.go:343-347)", () => {
    const spec = legacyBuildLogflareContainerSpec({ ...base, backend: "postgres" });
    expect(spec.env.POSTGRES_BACKEND_URL).toBe(
      "postgresql://postgres:secret@supabase_db_proj:5432/_supabase",
    );
    expect(spec.env.POSTGRES_BACKEND_SCHEMA).toBe("_analytics");
    expect(spec.env.GOOGLE_PROJECT_ID).toBeUndefined();
    expect(spec.env.GOOGLE_PROJECT_NUMBER).toBeUndefined();
    expect(spec.env.GOOGLE_DATASET_ID_APPEND).toBeUndefined();
    expect(spec.binds).toEqual([]);
  });

  test("bigquery backend: sets GOOGLE_* env and binds the host JWT path, no postgres env (start.go:334-342)", () => {
    const spec = legacyBuildLogflareContainerSpec({
      ...base,
      backend: "bigquery",
      gcpProjectId: "my-project",
      gcpProjectNumber: "123456",
      gcpJwtPath: "gcloud.json",
      workdir: "/workdir",
    });
    expect(spec.env.GOOGLE_DATASET_ID_APPEND).toBe("_prod");
    expect(spec.env.GOOGLE_PROJECT_ID).toBe("my-project");
    expect(spec.env.GOOGLE_PROJECT_NUMBER).toBe("123456");
    expect(spec.env.POSTGRES_BACKEND_URL).toBeUndefined();
    expect(spec.env.POSTGRES_BACKEND_SCHEMA).toBeUndefined();
    expect(spec.binds).toEqual([
      `${join("/workdir", "gcloud.json")}:/opt/app/rel/logflare/bin/gcloud.json`,
    ]);
  });

  test("bigquery backend still binds workdir itself when gcpJwtPath is empty, matching Go's unconditional filepath.Join", () => {
    const spec = legacyBuildLogflareContainerSpec({
      ...base,
      backend: "bigquery",
      gcpJwtPath: "",
      workdir: "/workdir",
    });
    expect(spec.binds).toEqual([`${join("/workdir", "")}:/opt/app/rel/logflare/bin/gcloud.json`]);
  });
});
