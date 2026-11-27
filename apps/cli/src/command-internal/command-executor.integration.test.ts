import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";

import { commandRuntimeLayer } from "../shared/runtime/command-runtime.layer.ts";
import { Output } from "../shared/output/output.service.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../tests/helpers/command-mocks.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { EventCommandExecuted, PropExitCode } from "../shared/telemetry/event-catalog.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import {
  CommandExecutor,
  CommandUX,
  ResolvedProject,
  commandExecutorLayer,
  withLegacyOutputHandler,
  withManagedHandler,
} from "./command-executor.ts";

const runtime = Layer.merge(commandExecutorLayer, commandRuntimeLayer(["test"]));
const collaborators = (out: ReturnType<typeof mockOutput>) =>
  buildTestRuntime({
    out,
    api: mockCommandPlatformApi({}),
    cliSettings: mockCommandSettings({ workdir: "/unused" }),
  });

const output = Schema.Struct({ value: Schema.String });

it("requires the handler to return the declared result", () => {
  withManagedHandler({
    output,
    // @ts-expect-error The declared schema requires a string value.
    handler: () => Effect.succeed({ value: 1 }),
    runtime: { required: Layer.empty, completion: Layer.empty },
  });
});
it("requires explicit and exclusive result ownership", () => {
  const handler = () => Effect.succeed({ value: "done" });
  const runtime = { required: Layer.empty, completion: Layer.empty };
  // @ts-expect-error Managed declarations must supply an output schema.
  withManagedHandler({ handler, runtime });
  // @ts-expect-error Legacy declarations cannot supply an output schema.
  withLegacyOutputHandler({ handler, runtime, output });
});

it.effect("keeps legacy bytes and waits for scoped release on interruption", () => {
  const out = mockOutput({ format: "stream-json" });
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const releasing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const handler = () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Deferred.succeed(releasing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(released, undefined)),
          ),
        );
        const writer = yield* Output;
        yield* writer.raw("legacy bytes\n");
        yield* Deferred.succeed(ready, undefined);
        return yield* Effect.never;
      });
    const fiber = yield* CommandExecutor.use((executor) =>
      executor.run({ owner: "handler", handler }, {}, Layer.empty),
    ).pipe(Effect.forkChild);
    yield* Effect.gen(function* () {
      yield* Deferred.await(ready);
      const cancel = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.await(releasing);
      expect(out.stdoutText).toBe("legacy bytes\n");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancel);
      expect(yield* Deferred.isDone(released)).toBe(true);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(out.stdoutText).toBe("legacy bytes\n");
      expect(out.messages).toEqual([]);
      expect(out.failures).toEqual([]);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  }).pipe(Effect.provide(runtime.pipe(Layer.provideMerge(collaborators(out)))));
});

it.effect("records legacy output before a required layer release defect escapes", () => {
  const out = mockOutput({ format: "json" });
  const defect = new Error("required layer release failed");
  const events: unknown[] = [];
  const required = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => events.push({ release: true })).pipe(Effect.andThen(Effect.die(defect))),
    ),
  );
  const handler = () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => events.push({ handlerReleased: true })));
      yield* Output.use((writer) => writer.raw('{"legacy":true}\n'));
    });

  return Effect.gen(function* () {
    const exit = yield* CommandExecutor.use((executor) =>
      executor.run({ owner: "handler", handler }, {}, required),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
    expect(out.stdoutText).toBe('{"legacy":true}\n');
    expect(out.failures).toEqual([]);
    expect(events).toEqual([
      { handlerReleased: true },
      { exitCode: 0, stdout: '{"legacy":true}\n' },
      { release: true },
    ]);
  }).pipe(
    Effect.provideServiceEffect(
      Analytics,
      Analytics.use((sink) =>
        Effect.succeed({
          ...sink,
          capture: (event, properties) =>
            Effect.sync(() => {
              if (event === EventCommandExecuted) {
                events.push({ exitCode: properties?.[PropExitCode], stdout: out.stdoutText });
              }
            }),
        }),
      ),
    ),
    Effect.provide(runtime.pipe(Layer.provideMerge(collaborators(out)))),
  );
});

const run = <E, R>(handler: () => Effect.Effect<typeof output.Type, E, R>) =>
  CommandExecutor.use((executor) =>
    executor.run({ owner: "executor", output, handler }, {}, Layer.empty),
  );

it.effect.each(["interrupt", "defect"] as const)("clears a text task once on %s", (outcome) => {
  const out = mockOutput({ format: "text" });
  const defect = new Error("operation failed");
  let clears = 0;
  return Effect.gen(function* () {
    const exit = yield* run(() =>
      CommandUX.use((ux) =>
        ux.task("Working", outcome === "interrupt" ? Effect.interrupt : Effect.die(defect)),
      ),
    ).pipe(Effect.exit);
    expect(clears).toBe(1);
    if (outcome === "interrupt")
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    else expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
  }).pipe(
    Effect.provideServiceEffect(
      Output,
      Output.use((writer) =>
        Effect.succeed({
          ...writer,
          task: (label) =>
            writer.task(label).pipe(
              Effect.map((task) => ({
                ...task,
                clear: Effect.sync(() => {
                  clears++;
                  throw new Error("clear failed");
                }),
              })),
            ),
        }),
      ),
    ),
    Effect.provide(runtime.pipe(Layer.provideMerge(collaborators(out)))),
  );
});

it.effect("waits for required finalization before delivering the result", () => {
  const out = mockOutput({ format: "json" });
  return Effect.gen(function* () {
    const releaseStarted = yield* Deferred.make<void>();
    const allowRelease = yield* Deferred.make<void>();
    const fiber = yield* run(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(releaseStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowRelease)),
          ),
        );
        return { value: "result" };
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.gen(function* () {
      yield* Deferred.await(releaseStarted);
      expect(out.stdoutText).toBe("");
      yield* Deferred.succeed(allowRelease, undefined);
      yield* Fiber.join(fiber);
      expect(out.stdoutText).toBe('{"value":"result"}\n');
    }).pipe(Effect.ensuring(Deferred.succeed(allowRelease, undefined)));
  }).pipe(Effect.provide(runtime.pipe(Layer.provideMerge(collaborators(out)))));
});

it.effect("propagates a cleanup defect without attempting machine output", () => {
  const out = mockOutput({ format: "json" });
  const defect = new Error("release failed");
  return Effect.gen(function* () {
    const exit = yield* run(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(defect));
        return { value: "result" };
      }),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
    expect(out.stdoutText).toBe("");
    expect(out.failures).toEqual([]);
  }).pipe(Effect.provide(runtime.pipe(Layer.provideMerge(collaborators(out)))));
});

it.effect.each(["cache", "flush"] as const)(
  "delivers one result before optional %s fails",
  (failure) => {
    const out = mockOutput({ format: "json" });
    const calls: string[] = [];
    const optional = (step: "cache" | "flush", label: string) =>
      Effect.sync(() => {
        calls.push(`${label}: ${out.stdoutText.trimEnd()}`);
        if (failure === step) throw new Error(`${step} failed`);
      });
    return run(() =>
      ResolvedProject.use((project) =>
        project.record("parent").pipe(Effect.as({ value: "branch" })),
      ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls).toEqual(['cache parent: {"value":"branch"}', 'flush: {"value":"branch"}']);
          expect(out.stdoutText).toBe('{"value":"branch"}\n');
          expect(out.failures).toEqual([]);
        }),
      ),
      Effect.provideServiceEffect(
        TelemetryState,
        TelemetryState.use((state) =>
          Effect.succeed({ ...state, flush: optional("flush", "flush") }),
        ),
      ),
      Effect.provideServiceEffect(
        LinkedProjectCache,
        LinkedProjectCache.use((cache) =>
          Effect.succeed({ ...cache, cache: (ref) => optional("cache", `cache ${ref}`) }),
        ),
      ),
      Effect.provide(runtime.pipe(Layer.provideMerge(collaborators(out)))),
    );
  },
);
