// oxlint-disable effecttsgo/async-function -- These tests exercise the public Promise facade of config resolution through Vitest callbacks.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import {
  resolveConfig as resolveConfigEffect,
  type ResolveConfigOptions,
} from "./StackConfigResolver.ts";
import { StackBuildError } from "./errors.ts";
import type { PortSet } from "./PortCatalog.ts";

const testPorts: PortSet = {
  apiPort: 40_000,
  dbPort: 40_001,
  authPort: 40_002,
  postgrestPort: 40_003,
  postgrestAdminPort: 40_004,
  edgeRuntimePort: 40_016,
  edgeRuntimeInspectorPort: 40_017,
  realtimePort: 40_005,
  storagePort: 40_006,
  imgproxyPort: 40_007,
  mailpitPort: 40_008,
  mailpitSmtpPort: 40_009,
  mailpitPop3Port: 40_010,
  pgmetaPort: 40_011,
  studioPort: 40_012,
  analyticsPort: 40_013,
  vectorAdminPort: 40_018,
  poolerSessionPort: 40_014,
  poolerTransactionPort: 40_015,
  poolerApiPort: 40_019,
};

const resolveConfig = (
  config?: Parameters<typeof resolveConfigEffect>[0],
  options?: Partial<ResolveConfigOptions>,
) =>
  Effect.runPromise(
    resolveConfigEffect(config, { ...options, ports: options?.ports ?? testPorts }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

describe("resolved service preparation policies", () => {
  it("maps temporary-root filesystem failures to StackBuildError", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const failingFs = {
          ...fs,
          makeTempDirectory: () =>
            Effect.fail(
              systemError({
                _tag: "PermissionDenied",
                module: "test",
                method: "makeTempDirectory",
              }),
            ),
        };
        return yield* resolveConfigEffect(undefined, { ports: testPorts }).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFs),
          Effect.exit,
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        _tag: "Some",
        value: { _tag: "StackBuildError" },
      });
    }
  });

  it("applies explicit policies and catalog defaults while keeping Postgres eager", async () => {
    const config = await resolveConfig({
      servicePolicies: { postgrest: "eager", mailpit: "eager" },
      mailpit: {},
      stackRoot: "/tmp/stack-policy-test",
      runtimeRoot: "/tmp/runtime-policy-test",
    });

    expect(config.servicePolicies.postgres).toBe("eager");
    expect(config.servicePolicies.postgrest).toBe("eager");
    expect(config.servicePolicies.auth).toBe("lazy");
    expect(config.servicePolicies.mailpit).toBe("eager");
  });

  it("enables Edge Runtime in native mode when omitted, matching Docker defaults", async () => {
    const config = await resolveConfig();

    expect(config.edgeRuntime).not.toBe(false);
    expect(config.servicePolicies["edge-runtime"]).toBe("lazy");
  });

  it("resolves Docker-specific Vector and Pooler defaults", async () => {
    const config = await resolveConfig(
      { mode: "docker", analytics: {}, vector: {}, pooler: {} },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );

    expect(config.vector).toMatchObject({ version: "0.53.0-alpine" });
    expect(config.pooler).toMatchObject({ version: "2.9.7" });
  });

  it("resolves independent Pooler protocol ports and Mailpit data ownership", async () => {
    const config = await resolveConfig(
      {
        pooler: { sessionPort: 41_001, transactionPort: 41_002, apiPort: 41_003 },
        mailpit: { dataDir: "/tmp/explicit-mailpit" },
      },
      {
        ports: {
          ...testPorts,
          poolerSessionPort: 41_001,
          poolerTransactionPort: 41_002,
          poolerApiPort: 41_003,
        },
      },
    );

    expect(config.pooler).toMatchObject({
      sessionPort: 41_001,
      transactionPort: 41_002,
      apiPort: 41_003,
    });
    expect(config.mailpit).toMatchObject({ dataDir: "/tmp/explicit-mailpit" });
  });

  it("normalizes explicit Pooler versions for the selected runtime", async () => {
    const native = await resolveConfig({ pooler: { version: "2.9.10" } });
    expect(native.pooler).toMatchObject({ version: "v2.9.10" });

    const docker = await resolveConfig(
      { mode: "docker", pooler: { version: "v2.9.7" } },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );
    expect(docker.pooler).toMatchObject({ version: "2.9.7" });
  });

  it("rejects an unsupported lazy policy before port allocation", async () => {
    await expect(resolveConfig({ servicePolicies: { postgres: "lazy" } })).rejects.toBeInstanceOf(
      StackBuildError,
    );
  });

  it("rejects disabling postgres through the service policy manifest", async () => {
    await expect(resolveConfig({ servicePolicies: { postgres: "off" } })).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
  });

  it("resolves explicitly disabled core services to false without reserving ports", async () => {
    const config = await resolveConfig({ servicePolicies: { postgrest: "off" } });
    expect(config.postgrest).toBe(false);
    expect(config.servicePolicies.postgrest).toBe("off");
  });

  it("rejects a preparation policy for a service that is not configured", async () => {
    await expect(resolveConfig({ servicePolicies: { realtime: "eager" } })).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
  });

  it("rejects an eager service whose required public dependency is lazy before allocating ports", async () => {
    await expect(
      resolveConfig({
        analytics: {},
        vector: {},
        servicePolicies: { analytics: "lazy", vector: "eager" },
      }),
    ).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
  });
});
