// oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Integration tests await the public stack facade and coordinate native process fixtures.

import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option } from "effect";
import { systemError } from "effect/PlatformError";
import {
  createStack,
  type ForegroundStackHandle,
  type PlatformFactory,
  type ResolveConfigEffect,
} from "./createStack.ts";
import { platformFactory } from "./platform-node.ts";
import { resolveConfig, resolveConfig as resolveConfigEffect } from "./StackConfigResolver.ts";
import type { PortSet } from "./PortCatalog.ts";
import { toStackHandle } from "./stackHandle.ts";

const handles: ForegroundStackHandle[] = [];
const testPorts: PortSet = {
  apiPort: 40_000,
  dbPort: 40_001,
  authPort: 40_002,
  postgrestPort: 40_003,
  postgrestAdminPort: 40_004,
  edgeRuntimePort: 40_005,
  edgeRuntimeInspectorPort: 40_006,
  realtimePort: 40_007,
  storagePort: 40_008,
  imgproxyPort: 40_009,
  mailpitPort: 40_010,
  mailpitSmtpPort: 40_011,
  mailpitPop3Port: 40_012,
  pgmetaPort: 40_013,
  studioPort: 40_014,
  analyticsPort: 40_015,
  poolerPort: 40_016,
  poolerApiPort: 40_017,
};

afterEach(() => {
  const owned = handles.splice(0);
  return Effect.runPromise(Effect.forEach(owned, (handle) => handle.dispose, { discard: true }));
});

describe("direct createStack port ownership", () => {
  it("retries an automatic API port when the platform bind reports EADDRINUSE as a defect", async () => {
    let attempts = 0;
    const bindError = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    const collidingPlatformFactory: PlatformFactory = (options) => {
      attempts += 1;
      const platform = platformFactory(options);
      return attempts < 3
        ? Layer.mergeAll(platform, Layer.effectDiscard(Effect.die(bindError)))
        : platform;
    };

    const stack = await Effect.runPromise(
      createStack(
        { mode: "native", postgrest: false, auth: false },
        collidingPlatformFactory,
        { mode: "native", containerRuntime: null },
        resolveConfig,
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    handles.push(stack);

    expect(attempts).toBe(3);
  });

  it("allocates only active service fields without managed state", async () => {
    const stack = await Effect.runPromise(
      createStack(
        {
          mode: "native",
          postgrest: false,
          auth: false,
          edgeRuntime: false,
          realtime: false,
          storage: false,
          imgproxy: false,
          mailpit: false,
          pgmeta: false,
          studio: false,
          analytics: false,
          vector: false,
          pooler: false,
        },
        platformFactory,
        { mode: "native", containerRuntime: null },
        resolveConfig,
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    handles.push(stack);

    expect(stack.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stack.dbUrl).toMatch(/127\.0\.0\.1:\d+/);
    const activeServices = new Set(
      (await Effect.runPromise(stack.getStatus)).map((state) => state.name),
    );
    expect(activeServices).not.toContain("studio");
    expect(activeServices).not.toContain("analytics");
    expect(activeServices).not.toContain("pooler");
  });

  it("isolates resolver-owned roots across repeated evaluations", async () => {
    const createdPaths: string[] = [];
    let failNextRoot = false;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const trackingFs = {
          ...fs,
          makeTempDirectory: (options: Parameters<typeof fs.makeTempDirectory>[0]) =>
            Effect.suspend(() =>
              failNextRoot
                ? Effect.fail(
                    systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "makeTempDirectory",
                      description: "injected failure",
                    }),
                  )
                : fs
                    .makeTempDirectory(options)
                    .pipe(Effect.tap((path) => Effect.sync(() => createdPaths.push(path)))),
            ),
        };
        const resolver = resolveConfigEffect({ mode: "native" }, { ports: testPorts });
        const firstConfig = yield* resolver.pipe(
          Effect.provideService(FileSystem.FileSystem, trackingFs),
        );
        const firstPaths = [...firstConfig.autoManagedPaths];
        failNextRoot = true;
        const secondExit = yield* resolver.pipe(
          Effect.provideService(FileSystem.FileSystem, trackingFs),
          Effect.exit,
        );
        const firstPathsExist = firstPaths.map((path) => existsSync(path));
        yield* Effect.forEach(
          firstPaths,
          (path) => fs.remove(path, { recursive: true, force: true }),
          { discard: true },
        );
        return { firstPaths, firstPathsExist, secondExit };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    expect(result.firstPaths).toHaveLength(2);
    expect(createdPaths).toEqual(result.firstPaths);
    expect(result.firstPathsExist).toEqual([true, true]);
    expect(Exit.isFailure(result.secondExit)).toBe(true);
    if (Exit.isFailure(result.secondExit)) {
      expect(Cause.findErrorOption(result.secondExit.cause)).toMatchObject({
        _tag: "Some",
        value: { _tag: "StackBuildError" },
      });
    }
    expect(result.firstPaths.every((path) => !existsSync(path))).toBe(true);
  });

  it("releases a resolver lease when creation is interrupted", async () => {
    const leasedPort = Deferred.makeUnsafe<number>();
    const resolveBlocked: ResolveConfigEffect = (_config, options) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(leasedPort, options?.ports.apiPort ?? 0);
        return yield* Effect.never;
      });

    const fiber = Effect.runFork(
      createStack(
        { mode: "native" },
        platformFactory,
        { mode: "native", containerRuntime: null },
        resolveBlocked,
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    const port = await Effect.runPromise(Deferred.await(leasedPort));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const server = createServer();
    let bound = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          bound = true;
          resolve();
        });
      });
    } finally {
      if (bound) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
    }
    expect(bound).toBe(true);
  });

  it("shares foreground disposal completion across concurrent callers", async () => {
    const finalizerStarted = Deferred.makeUnsafe<void>();
    const releaseFinalizer = Deferred.makeUnsafe<void>();
    const gatedPlatformFactory: PlatformFactory = (options) =>
      Layer.mergeAll(
        platformFactory(options),
        Layer.effectDiscard(
          Effect.addFinalizer(() =>
            Deferred.succeed(finalizerStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFinalizer)),
              Effect.asVoid,
            ),
          ),
        ),
      );

    const stack = await Effect.runPromise(
      createStack(
        {
          mode: "native",
          postgrest: false,
          auth: false,
          edgeRuntime: false,
          realtime: false,
          storage: false,
          imgproxy: false,
          mailpit: false,
          pgmeta: false,
          studio: false,
          analytics: false,
          vector: false,
          pooler: false,
        },
        gatedPlatformFactory,
        { mode: "native", containerRuntime: null },
        resolveConfig,
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    handles.push(stack);
    const publicStack = toStackHandle(stack);

    const secondInvoked = Deferred.makeUnsafe<void>();
    const secondDone = Deferred.makeUnsafe<void>();
    const firstDisposal = Effect.runFork(Effect.promise(() => publicStack.dispose()));
    await Effect.runPromise(Deferred.await(finalizerStarted));
    const secondDisposal = Effect.runFork(
      Effect.promise(() => {
        Effect.runSync(Deferred.succeed(secondInvoked, undefined));
        return publicStack.dispose();
      }).pipe(Effect.andThen(Deferred.succeed(secondDone, undefined)), Effect.asVoid),
    );

    await Effect.runPromise(Deferred.await(secondInvoked));
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(secondDone)))).toBe(true);
    await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
    const [firstExit, secondExit] = await Effect.runPromise(
      Effect.all([Fiber.await(firstDisposal), Fiber.await(secondDisposal)]),
    );
    expect(Exit.isSuccess(firstExit)).toBe(true);
    expect(Exit.isSuccess(secondExit)).toBe(true);
  });
});
