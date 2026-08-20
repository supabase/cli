import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { resolveConfig as resolveConfigEffect } from "./StackConfigResolver.ts";
import { StackBuildError } from "./errors.ts";

const resolveConfig = (...args: Parameters<typeof resolveConfigEffect>) =>
  Effect.runPromise(resolveConfigEffect(...args).pipe(Effect.provide(NodeFileSystem.layer)));

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
        return yield* resolveConfigEffect().pipe(
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

  it("rejects an unsupported lazy policy before port allocation", async () => {
    let allocated = false;
    await expect(
      resolveConfig(
        { servicePolicies: { postgres: "lazy" } },
        {
          portAllocator: () => {
            allocated = true;
            throw new Error("must not allocate");
          },
        },
      ),
    ).rejects.toBeInstanceOf(StackBuildError);
    expect(allocated).toBe(false);
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
    let allocated = false;
    await expect(
      resolveConfig(
        {
          analytics: {},
          vector: {},
          servicePolicies: { analytics: "lazy", vector: "eager" },
        },
        {
          portAllocator: () => {
            allocated = true;
            throw new Error("must not allocate");
          },
        },
      ),
    ).rejects.toMatchObject({
      _tag: "StackBuildError",
      reason: "invalid_config",
    });
    expect(allocated).toBe(false);
  });
});
