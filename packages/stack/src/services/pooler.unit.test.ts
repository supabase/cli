import { describe, expect, it } from "vitest";
import { makePoolerServicesNative } from "./pooler.ts";

const dependencies = [{ service: "postgres-init", condition: "completed" }] as const;

const makePooler = (mode: "transaction" | "session") =>
  makePoolerServicesNative({
    binPath: "/cache/pooler/v2.9.10/darwin-arm64",
    runtimeRoot: "/tmp/stacks/project-a/runtime",
    adminPort: 54329,
    port: 54330,
    dbPort: 54322,
    poolMode: mode,
    defaultPoolSize: 20,
    maxClientConn: 100,
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    tenantId: "pooler-dev",
    encryptionKey: "12345678901234567890123456789012",
    secretKeyBase: "1234567890123456789012345678901234567890123456789012345678901234",
    dependencies,
  });

describe("makePoolerServicesNative", () => {
  it("runs migrate, tenant bootstrap, and server in dependency order", () => {
    const bundle = makePooler("transaction");

    expect(bundle.migrate).toMatchObject({
      name: "pooler-migrate",
      command: "/cache/pooler/v2.9.10/darwin-arm64/bin/migrate",
      restart: "no",
      dependencies,
    });
    expect(bundle.bootstrap).toMatchObject({
      name: "pooler-bootstrap",
      command: "/cache/pooler/v2.9.10/darwin-arm64/bin/supavisor",
      restart: "no",
      dependencies: [{ service: "pooler-migrate", condition: "completed" }],
    });
    expect(bundle.bootstrap.args?.[0]).toBe("eval");
    expect(bundle.bootstrap.args?.[1]).toContain('"external_id" => "pooler-dev"');
    expect(bundle.server).toMatchObject({
      name: "pooler",
      command: "/cache/pooler/v2.9.10/darwin-arm64/bin/server",
      restart: "unless-stopped",
      dependencies: [{ service: "pooler-bootstrap", condition: "completed" }],
    });
    expect(bundle.server.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54329,
      path: "/api/health",
      scheme: "http",
    });
  });

  it("only binds the selected public proxy listener and keeps the other dormant", () => {
    const transaction = makePooler("transaction").server;
    expect(transaction.env).toMatchObject({
      PORT: "54329",
      PROXY_PORT_TRANSACTION: "54330",
      PROXY_PORT_SESSION: "0",
      ELIXIR_ERL_OPTIONS: "+fnu +S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none",
      ERL_CRASH_DUMP: "/tmp/stacks/project-a/runtime/pooler/erl_crash.dump",
    });

    const session = makePooler("session").server;
    expect(session.env).toMatchObject({
      PROXY_PORT_TRANSACTION: "0",
      PROXY_PORT_SESSION: "54330",
    });
  });
});
