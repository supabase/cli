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
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import {
  CommandExecutor,
  CommandUX,
  PendingProjectCacheFill,
  commandExecutorLayer,
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
const run = <E, R>(handler: () => Effect.Effect<typeof output.Type, E, R>) =>
  CommandExecutor.use((executor) => executor.run({ output, handler }, {}, Layer.empty));

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

it.effect("reports a cleanup defect instead of delivering success", () => {
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
    expect(out.messages).toEqual([
      expect.objectContaining({ type: "fail", message: "release failed" }),
    ]);
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
      PendingProjectCacheFill.use((cacheFill) =>
        cacheFill.request("parent").pipe(Effect.as({ value: "branch" })),
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
