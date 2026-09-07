import { describe, expect, test } from "vitest";

import { legacyBuildMailpitContainerSpec } from "./mailpit.service.ts";

describe("legacyBuildMailpitContainerSpec", () => {
  test("builds the minimal spec with only the always-on web UI port bound (start.go:853-901)", () => {
    const spec = legacyBuildMailpitContainerSpec({
      image: "supabase/mailpit:v1",
      projectId: "proj",
      networkId: "supabase_network_proj",
      port: 54324,
    });

    expect(spec).toEqual({
      image: "supabase/mailpit:v1",
      containerName: "supabase_inbucket_proj",
      env: { MP_SMTP_DISABLE_RDNS: "true" },
      binds: [],
      ports: [{ hostPort: "54324", containerPort: "8025" }],
      healthcheck: {
        test: ["CMD", "/mailpit", "readyz"],
        intervalSeconds: 10,
        timeoutSeconds: 2,
        retries: 3,
        startPeriodSeconds: 10,
      },
      restartPolicy: "unless-stopped",
      networkId: "supabase_network_proj",
      networkAliases: ["inbucket"],
      labels: {},
    });
  });

  test("adds the SMTP port binding only when smtpPort is set and non-zero (start.go:858-862)", () => {
    const spec = legacyBuildMailpitContainerSpec({
      image: "img",
      projectId: "proj",
      networkId: "net",
      port: 54324,
      smtpPort: 54325,
    });
    expect(spec.ports).toEqual([
      { hostPort: "54324", containerPort: "8025" },
      { hostPort: "54325", containerPort: "1025" },
    ]);
  });

  test("omits the SMTP port binding when smtpPort is explicitly 0, matching Go's zero-value guard", () => {
    const spec = legacyBuildMailpitContainerSpec({
      image: "img",
      projectId: "proj",
      networkId: "net",
      port: 54324,
      smtpPort: 0,
    });
    expect(spec.ports).toEqual([{ hostPort: "54324", containerPort: "8025" }]);
  });

  test("adds the POP3 port binding only when pop3Port is set and non-zero (start.go:863-867)", () => {
    const spec = legacyBuildMailpitContainerSpec({
      image: "img",
      projectId: "proj",
      networkId: "net",
      port: 54324,
      pop3Port: 1110,
    });
    expect(spec.ports).toEqual([
      { hostPort: "54324", containerPort: "8025" },
      { hostPort: "1110", containerPort: "1110" },
    ]);
  });

  test("adds both optional ports together, in Go's declared order", () => {
    const spec = legacyBuildMailpitContainerSpec({
      image: "img",
      projectId: "proj",
      networkId: "net",
      port: 54324,
      smtpPort: 54325,
      pop3Port: 1110,
    });
    expect(spec.ports).toEqual([
      { hostPort: "54324", containerPort: "8025" },
      { hostPort: "54325", containerPort: "1025" },
      { hostPort: "1110", containerPort: "1110" },
    ]);
  });
});
