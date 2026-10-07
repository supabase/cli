import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { StackError } from "@supabase/stack/effect";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Ref, Stream } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackRestart } from "./restart.handler.ts";
import { destroyTestStack } from "../../../../../tests/helpers/stack-cleanup.ts";
import { stackArtifactCacheRoot } from "../../../../../tests/helpers/stack-artifacts.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);
const fixture = Effect.fn("StackRestartTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-restart-" });
  const api = yield* StackApi;
  const locations = {
    stateRoot: path.join(root, "stacks"),
    cacheRoot: stackArtifactCacheRoot,
  };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "native" });
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(Layer.provide(settings)),
  );
  return {
    api,
    locations,
    stack,
    output,
    telemetry,
    layer,
    flags: { stack: Option.none<string>(), stackId: Option.some(stack.id) },
  };
});

describe("stack restart", () => {
  it.live(
    "restarts saved members while leaving a running standalone service untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.acquireUseRelease(
          Effect.succeed(f.stack),
          (stack) =>
            Effect.gen(function* () {
              const member = yield* stack.services.create({
                service: "mail",
                config: {},
                endpoints: { http: { port: "auto" } },
              });
              const standalone = yield* stack.services.create({
                service: "mail",
                config: {},
                endpoints: { http: { port: "auto" } },
              });
              yield* stack.composition.configure({
                members: [{ id: member.id, activation: "eager" }],
                dependencies: [],
              });
              yield* stack.composition.start;
              yield* standalone.start;
              yield* standalone.ready;
              const before = yield* member.status;

              // Both follows are subscribed once their first status arrives, before the restart.
              const memberFollowing = yield* Deferred.make<void>();
              const relaunched = yield* member.followStatus.pipe(
                Stream.tap(() => Deferred.succeed(memberFollowing, undefined)),
                Stream.dropWhile((value) => value.lifecycle === "running"),
                Stream.filter(
                  (value) => value.lifecycle === "running" && value.health === "healthy",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              const standaloneFollowing = yield* Deferred.make<void>();
              const standaloneLifecycles = yield* Ref.make<ReadonlyArray<string>>([]);
              yield* standalone.followStatus.pipe(
                Stream.tap((value) =>
                  Ref.update(standaloneLifecycles, (seen) => [...seen, value.lifecycle]).pipe(
                    Effect.andThen(Deferred.succeed(standaloneFollowing, undefined)),
                  ),
                ),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* Deferred.await(memberFollowing);
              yield* Deferred.await(standaloneFollowing);

              const result = yield* stackRestart(f.flags).pipe(Effect.provide(f.layer));
              yield* Fiber.join(relaunched);
              const after = yield* member.status;
              const standaloneAfter = yield* standalone.status;
              expect(result.map(({ id }) => id)).toEqual([member.id]);
              expect(after.lifecycle).toBe("running");
              expect(after.health).toBe("healthy");
              expect(after.endpoints).toEqual(before.endpoints);
              expect(standaloneAfter.lifecycle).toBe("running");
              expect(new Set(yield* Ref.get(standaloneLifecycles))).toEqual(new Set(["running"]));
              expect(f.output.stdoutText).toContain("using its saved configuration");
              expect(f.telemetry.flushed).toBe(true);
              yield* stack.stop;
              const reopened = yield* stackRestart(f.flags).pipe(Effect.provide(f.layer));
              expect(reopened.map(({ id }) => id)).toEqual([member.id]);
              const resumed = yield* member.status;
              expect(resumed.endpoints).toEqual(before.endpoints);
              expect(resumed.lifecycle).toBe("running");
              expect(resumed.health).toBe("healthy");
              expect((yield* standalone.status).lifecycle).toBe("stopped");
            }),
          destroyTestStack,
        );
      }).pipe(Effect.provide(live)),
    60_000,
  );

  it.live("rejects an unconfigured namespace without starting an owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* stackRestart(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("lifecycle");
      expect((yield* f.api.discover(f.locations))[0]?.host).toBeUndefined();
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("identifies failed members when a composition restart fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const failure = new StackError({
        operation: "composition.restart",
        message: "Some services failed to restart",
        outcomes: [
          { id: "database-instance", succeeded: true },
          { id: "rest-instance", succeeded: false, error: "Port is occupied" },
        ],
      });
      const api = Layer.succeed(
        StackApi,
        StackApi.of({
          ...f.api,
          open: () =>
            Effect.succeed({
              ...f.stack,
              composition: {
                ...f.stack.composition,
                describe: Effect.succeed({
                  members: [{ id: "rest-instance", activation: "lazy" }],
                  dependencies: [],
                }),
                restart: Effect.fail(failure),
              },
            }),
        }),
      );
      const error = yield* stackRestart(f.flags).pipe(
        Effect.provide(Layer.provideMerge(f.layer, api)),
        Effect.flip,
      );
      expect(error.message).toBe("Some services failed to restart");
      expect(error.detail).toBe("rest-instance: Port is occupied");
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );
});
