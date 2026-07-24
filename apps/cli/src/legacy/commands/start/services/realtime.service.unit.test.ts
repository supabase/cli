import { describe, expect, test } from "vitest";

import {
  legacyBuildRealtimeContainerSpec,
  legacyBuildRealtimeEnv,
  type LegacyRealtimeContainerSpecInput,
} from "./realtime.service.ts";

describe("legacyBuildRealtimeEnv", () => {
  const base = {
    ipVersion: "IPv4" as const,
    maxHeaderLength: 4096,
    dbHost: "supabase_db_proj",
    dbPassword: "postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: '{"keys":[]}',
  };

  test("wires the fixed internal DB address, JWT secret, and JWKS", () => {
    const env = legacyBuildRealtimeEnv(base);
    expect(env["DB_HOST"]).toBe("supabase_db_proj");
    expect(env["DB_PORT"]).toBe("5432");
    expect(env["DB_USER"]).toBe("supabase_admin");
    expect(env["DB_PASSWORD"]).toBe("postgres");
    expect(env["DB_NAME"]).toBe("postgres");
    expect(env["API_JWT_SECRET"]).toBe(base.jwtSecret);
    expect(env["METRICS_JWT_SECRET"]).toBe(base.jwtSecret);
    expect(env["API_JWT_JWKS"]).toBe(base.jwks);
  });

  test("matches Go's remaining static env values", () => {
    const env = legacyBuildRealtimeEnv(base);
    expect(env).toMatchObject({
      PORT: "4000",
      DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
      DB_ENC_KEY: "supabaserealtime",
      APP_NAME: "realtime",
      SECRET_KEY_BASE: "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
      DNS_NODES: "''",
      RLIMIT_NOFILE: "",
      SEED_SELF_HOST: "true",
      RUN_JANITOR: "true",
      MAX_HEADER_LENGTH: "4096",
    });
  });

  test("selects inet_tcp for IPv4", () => {
    expect(legacyBuildRealtimeEnv({ ...base, ipVersion: "IPv4" })["ERL_AFLAGS"]).toBe(
      "-proto_dist inet_tcp",
    );
  });

  test("selects inet6_tcp for IPv6", () => {
    expect(legacyBuildRealtimeEnv({ ...base, ipVersion: "IPv6" })["ERL_AFLAGS"]).toBe(
      "-proto_dist inet6_tcp",
    );
  });
});

describe("legacyBuildRealtimeContainerSpec", () => {
  const input: LegacyRealtimeContainerSpecInput = {
    projectId: "proj",
    networkId: "supabase_network_proj",
    image: "supabase/realtime:v2",
    ipVersion: "IPv4",
    maxHeaderLength: 4096,
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: '{"keys":[]}',
  };

  test("derives the container name and internal DB host from projectId", () => {
    const spec = legacyBuildRealtimeContainerSpec(input);
    expect(spec.containerName).toBe("supabase_realtime_proj");
    expect(spec.env["DB_HOST"]).toBe("supabase_db_proj");
    expect(spec.env["DB_PASSWORD"]).toBe("postgres");
  });

  test("exposes port 4000 with no host-published port binding", () => {
    const spec = legacyBuildRealtimeContainerSpec(input);
    expect(spec.exposedPorts).toEqual([{ containerPort: "4000" }]);
    expect(spec.ports).toBeUndefined();
  });

  test("builds the exec-form healthcheck with the tenant id host header", () => {
    const spec = legacyBuildRealtimeContainerSpec(input);
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD",
        "curl",
        "-sSfL",
        "--head",
        "-o",
        "/dev/null",
        "-H",
        "Host:realtime-dev",
        "http://127.0.0.1:4000/api/ping",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
  });

  test("network aliases are 'realtime' and the tenant id", () => {
    const spec = legacyBuildRealtimeContainerSpec(input);
    expect(spec.networkAliases).toEqual(["realtime", "realtime-dev"]);
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.labels).toEqual({});
  });

  test("reuses (does not recompute) the resolved db password from a non-default dbUrl", () => {
    const spec = legacyBuildRealtimeContainerSpec({
      ...input,
      dbUrl: "postgresql://postgres:another-secret@127.0.0.1:54322/postgres",
    });
    expect(spec.env["DB_PASSWORD"]).toBe("another-secret");
  });
});
