import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { createStack, type ForegroundStackHandle, type PlatformFactory } from "./createStack.ts";
import { platformFactory } from "./platform-node.ts";
import { toStackHandle } from "./stackHandle.ts";

const handles: ForegroundStackHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => Effect.runPromise(handle.dispose())));
});

describe("direct createStack port ownership", () => {
  it("reselects an automatic API port when the platform bind loses the handoff race", async () => {
    let attempts = 0;
    const retryingPlatformFactory: PlatformFactory = (options) => {
      attempts += 1;
      if (attempts > 1) return platformFactory(options);
      const addressInUse = Object.assign(new Error("API port was claimed during handoff"), {
        code: "EADDRINUSE",
      });
      return Layer.mergeAll(
        platformFactory(options),
        Layer.effectDiscard(Effect.die(addressInUse)),
      );
    };

    const stack = await Effect.runPromise(
      createStack(
        {
          mode: "native",
          startupMode: "lazy",
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
        retryingPlatformFactory,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    handles.push(stack);

    expect(attempts).toBe(2);
    expect(stack.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("allocates only active service fields without managed state", async () => {
    const stack = await Effect.runPromise(
      createStack(
        {
          mode: "native",
          startupMode: "lazy",
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
      ).pipe(Effect.provide(NodeFileSystem.layer)),
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

  it("shares in-flight disposal across concurrent public callers", async () => {
    const finalizerStarted = Deferred.makeUnsafe<void>();
    const releaseFinalizer = Deferred.makeUnsafe<void>();
    const gatedPlatformFactory = (options: Parameters<typeof platformFactory>[0]) =>
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
      ).pipe(Effect.provide(NodeFileSystem.layer)),
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
    expect(await Effect.runPromise(Deferred.isDone(secondDone))).toBe(false);
    await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
    const [firstExit, secondExit] = await Effect.runPromise(
      Effect.all([Fiber.await(firstDisposal), Fiber.await(secondDisposal)]),
    );
    expect(Exit.isSuccess(firstExit)).toBe(true);
    expect(Exit.isSuccess(secondExit)).toBe(true);
  });
});
