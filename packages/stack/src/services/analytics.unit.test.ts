import { describe, expect, it } from "vitest";
import { makeAnalyticsServicesNative } from "./analytics.ts";

describe("makeAnalyticsServicesNative", () => {
  it("runs migration before a loopback server with the frozen runtime profile", () => {
    const dependencies = [{ service: "postgres-init", condition: "completed" }] as const;
    const bundle = makeAnalyticsServicesNative({
      binPath: "/cache/analytics/v1.50.3/darwin-arm64",
      runtimeRoot: "/tmp/stacks/project-a/runtime",
      nodeName: "logflare_stack_a",
      hostPort: 54327,
      dbPort: 54322,
      apiKey: "analytics-key",
      backend: "postgres",
      dependencies,
    });

    expect(bundle.migrate).toMatchObject({
      name: "analytics-migrate",
      command: "/cache/analytics/v1.50.3/darwin-arm64/bin/logflare",
      args: ["eval", "Logflare.Release.migrate"],
      restart: "no",
      dependencies,
    });
    expect(bundle.server).toMatchObject({
      name: "analytics",
      command: "/cache/analytics/v1.50.3/darwin-arm64/bin/logflare",
      args: ["start", "--sname", "logflare_stack_a"],
      restart: "unless-stopped",
      dependencies: [{ service: "analytics-migrate", condition: "completed" }],
    });
    expect(bundle.server.env).toMatchObject({
      PORT: "54327",
      PHX_HTTP_PORT: "54327",
      PHX_HTTP_IP: "127.0.0.1",
      DB_HOSTNAME: "127.0.0.1",
      LOGFLARE_NODE_HOST: "127.0.0.1",
      DB_POOL_SIZE: "2",
      LOGFLARE_PUBSUB_POOL_SIZE: "2",
      ELIXIR_ERL_OPTIONS: "+S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none",
      ERL_CRASH_DUMP: "/tmp/stacks/project-a/runtime/analytics/erl_crash.dump",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: "analytics-key",
    });
    expect(bundle.server.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54327,
      path: "/health",
      scheme: "http",
    });
  });
});
