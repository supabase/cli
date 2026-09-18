import { afterEach, describe, expect, test, vi } from "vitest";

import { buildRealtimeContainerSpec, type RealtimeContainerSpecInput } from "./realtime.service.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildRealtimeContainerSpec", () => {
  const input: RealtimeContainerSpecInput = {
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
    const spec = buildRealtimeContainerSpec(input);
    expect(spec.containerName).toBe("supabase_realtime_proj");
    expect(spec.env["DB_HOST"]).toBe("supabase_db_proj");
    expect(spec.env["DB_PASSWORD"]).toBe("postgres");
  });

  test("exposes port 4000 with no host-published port binding", () => {
    const spec = buildRealtimeContainerSpec(input);
    expect(spec.exposedPorts).toEqual([{ containerPort: "4000" }]);
    expect(spec.ports).toBeUndefined();
  });

  test("builds the exec-form healthcheck with the tenant id host header", () => {
    const spec = buildRealtimeContainerSpec(input);
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
    const spec = buildRealtimeContainerSpec(input);
    expect(spec.networkAliases).toEqual(["realtime", "realtime-dev"]);
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.labels).toEqual({});
  });

  test("reuses (does not recompute) the resolved db password from a non-default dbUrl", () => {
    const spec = buildRealtimeContainerSpec({
      ...input,
      dbUrl: "postgresql://postgres:another-secret@127.0.0.1:54322/postgres",
    });
    expect(spec.env["DB_PASSWORD"]).toBe("another-secret");
  });

  test("uses wget for the healthcheck on a slim realtime image", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = buildRealtimeContainerSpec({
      ...input,
      image: "ghcr.io/supabase/cli/realtime:v2.130.0",
    });
    expect(spec.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "--spider",
      "--header",
      "Host:realtime-dev",
      "http://127.0.0.1:4000/api/ping",
    ]);
  });
});
