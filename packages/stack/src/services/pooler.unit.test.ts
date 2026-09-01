import { describe, expect, it } from "vitest";
import { makePoolerServicesNative } from "./pooler.ts";

const dependencies = [{ service: "postgres-init", condition: "completed" }] as const;

const makePooler = (mode: "transaction" | "session", tenantId = "pooler-dev") =>
  makePoolerServicesNative({
    binPath: "/cache/pooler/v2.9.10/darwin-arm64",
    runtimeRoot: "/tmp/stacks/project-a/runtime",
    adminPort: 54329,
    sessionPort: 54330,
    transactionPort: 54331,
    internalPort: 54400,
    dbPort: 54322,
    poolMode: mode,
    defaultPoolSize: 20,
    maxClientConn: 100,
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    tenantId,
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
    expect(bundle.bootstrap.env).toMatchObject({
      PORT: "0",
      PROXY_PORT: "0",
      PROXY_PORT_SESSION: "0",
      PROXY_PORT_TRANSACTION: "0",
      SESSION_PROXY_PORTS: "54400,54401,54402,54403",
      TRANSACTION_PROXY_PORTS: "54404,54405,54406,54407",
      DATABASE_URL: "ecto://postgres:postgres@127.0.0.1:54322/_supabase",
      API_JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
      RELEASE_DISTRIBUTION: "none",
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

  it("binds both public proxy listeners", () => {
    const transaction = makePooler("transaction").server;
    expect(transaction.env).toMatchObject({
      PORT: "54329",
      PROXY_PORT_TRANSACTION: "54331",
      PROXY_PORT_SESSION: "54330",
      SESSION_PROXY_PORTS: "54400,54401,54402,54403",
      TRANSACTION_PROXY_PORTS: "54404,54405,54406,54407",
      RELEASE_DISTRIBUTION: "none",
      ELIXIR_ERL_OPTIONS: "+fnu +S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none",
      ERL_CRASH_DUMP: "/tmp/stacks/project-a/runtime/pooler/erl_crash.dump",
    });
    expect(transaction.env).not.toHaveProperty("ERL_AFLAGS");
    expect(transaction.env).not.toHaveProperty("ERL_EPMD_ADDRESS");
    expect(transaction.env).not.toHaveProperty("NODE_NAME");
    expect(transaction.env).not.toHaveProperty("NODE_IP");
    expect(transaction.env).not.toHaveProperty("RELEASE_NODE");
    expect(transaction.env).not.toHaveProperty("RELEASE_COOKIE");

    const session = makePooler("session").server;
    expect(session.env).toMatchObject({
      PROXY_PORT_TRANSACTION: "54331",
      PROXY_PORT_SESSION: "54330",
    });
  });

  it("encodes tenant IDs as safe Elixir string literals", () => {
    const tenantId = 'tenant"\\\\\n\r\t\u0000';
    const bundle = makePooler("transaction", tenantId);

    const script = bundle.bootstrap.args?.[1];
    expect(script).toContain('"external_id" => "tenant\\\"\\\\\\\\\\n\\r\\t\\u0000"');
  });

  it("escapes Elixir interpolation in tenant IDs", () => {
    const tenantId = 'tenant#{System.cmd("echo", ["unsafe"])}';
    const script = makePooler("transaction", tenantId).bootstrap.args?.[1];

    expect(script).toContain(
      '"external_id" => "tenant\\#{System.cmd(\\"echo\\", [\\"unsafe\\"])}"',
    );
  });
});
