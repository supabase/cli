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
import { toStackHandle } from "./stackHandle.ts";

const handles: ForegroundStackHandle[] = [];

afterEach(() => {
  const owned = handles.splice(0);
  return Effect.runPromise(Effect.forEach(owned, (handle) => handle.dispose(), { discard: true }));
});

describe("direct createStack port ownership", () => {
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
      (await Effect.runPromise(stack.getStatus())).map((state) => state.name),
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
        const resolver = resolveConfigEffect({ mode: "native" });
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
        const portAllocator = options?.portAllocator;
        if (portAllocator === undefined) {
          return yield* Effect.die("test resolver requires a port allocator");
        }
        const ports = yield* portAllocator(
          [{ field: "apiPort", selection: { kind: "automatic" } }],
          {},
        );
        yield* Deferred.succeed(leasedPort, ports.apiPort!);
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
    expect(firstExit._tag).toBe("Success");
    expect(secondExit._tag).toBe("Success");
  });
});
