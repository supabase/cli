import { expect, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Runtime, Schema } from "effect";
import { Command } from "effect/cli";
import process from "node:process";
import { vi } from "vitest";

import { mockAnalytics, mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  mockLinkedProjectCacheLayer,
  mockTelemetryStateLayer,
  useTempWorkdir,
  withEnvVar,
} from "../../../tests/helpers/command-mocks.ts";
import {
  commandExecutorLayer,
  withManagedHandler,
} from "../../command-internal/command-executor.ts";
import { OutputFormatFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../output/output.service.ts";
import { commandRuntimeLayer } from "../runtime/command-runtime.layer.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { runCli } from "./run.ts";

const processState = vi.hoisted(() => ({
  exit: undefined as ((code: number) => void) | undefined,
  output: undefined as ReturnType<typeof mockOutput> | undefined,
}));

// @effect-diagnostics-next-line asyncFunction:off -- Vitest loads dependencies in the hoisted factory.
vi.mock("../output/output.layer.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../output/output.layer.ts")>();
  return {
    ...original,
    outputLayerFor: (format: Parameters<typeof original.outputLayerFor>[0]) =>
      processState.output?.layer ?? original.outputLayerFor(format),
  };
});

// @effect-diagnostics-next-line asyncFunction:off -- Vitest loads dependencies in the hoisted factory.
vi.mock("../runtime/process-control.layer.ts", async () => {
  const { Effect, Layer } = await import("effect");
  const { ProcessControl } = await import("../runtime/process-control.service.ts");
  return {
    processControlLayer: Layer.sync(ProcessControl, () => {
      let exitCode: number | undefined;
      return ProcessControl.of({
        awaitSignal: () => Effect.never,
        awaitShutdown: Effect.never,
        holdSignals: () => Effect.void,
        setExitCode: (code) =>
          Effect.sync(() => {
            exitCode = code;
          }),
        getExitCode: Effect.sync(() => exitCode),
        exit: (code) =>
          Effect.sync(() => processState.exit?.(code)).pipe(Effect.andThen(Effect.interrupt)),
      });
    }),
  };
});

const home = useTempWorkdir("supabase-managed-output-");

const RequiredResource = Context.Service<string>("test/RequiredResource");

it.live.each([
  "warning",
  "cleanup-defect",
  "partial-write",
  "typed-failure",
  "held-layer-release",
  "layer-release-defect",
] as const)("requests the right exit without replacing terminal output: %s", (scenario) =>
  Effect.gen(function* () {
    const out = mockOutput({ format: "json" });
    const attempts: number[] = [];
    const error = Object.assign(new Error("managed failure"), { [Runtime.errorExitCode]: 7 });
    const releaseStarted = yield* Deferred.make<void>();
    const allowRelease = yield* Deferred.make<void>();
    const required = Layer.effect(
      RequiredResource,
      Effect.acquireRelease(Effect.succeed("done"), () =>
        scenario === "held-layer-release"
          ? Deferred.succeed(releaseStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowRelease)),
            )
          : scenario === "layer-release-defect"
            ? Effect.die(error)
            : Effect.void,
      ),
    );
    const root = Command.make("supabase").pipe(
      withManagedHandler({
        output: Schema.Struct({ value: Schema.String }),
        handler: () =>
          Effect.gen(function* () {
            const control = yield* ProcessControl;
            const writer = yield* Output;
            if (scenario === "typed-failure") return yield* Effect.fail(error);
            yield* Effect.addFinalizer(() =>
              scenario === "warning"
                ? Effect.fail("restoration rejected").pipe(
                    Effect.catch((reason) => writer.raw(`Cleanup warning: ${reason}\n`, "stderr")),
                    Effect.andThen(control.setExitCode(1)),
                  )
                : scenario === "cleanup-defect"
                  ? Effect.die(error)
                  : Effect.void,
            );
            return { value: yield* RequiredResource };
          }),
        runtime: {
          required,
          completion: Layer.mergeAll(
            scenario === "partial-write"
              ? Layer.effect(
                  Output,
                  Output.use((writer) =>
                    Effect.succeed({
                      ...writer,
                      result: () => writer.raw('{"value":').pipe(Effect.andThen(Effect.die(error))),
                    }),
                  ),
                ).pipe(Layer.provide(out.layer))
              : out.layer,
            commandExecutorLayer,
            mockLinkedProjectCacheLayer,
            mockTelemetryStateLayer,
            commandRuntimeLayer(["test"]),
          ),
        },
      }),
      Command.withGlobalFlags([OutputFormatFlag]),
    );
    const argv = process.argv;
    process.argv = [argv[0] ?? "bun", "supabase", "--output-format", "json"];
    processState.exit = (code) => {
      attempts.push(code);
    };
    processState.output = out;
    try {
      const run = withEnvVar(
        "SUPABASE_HOME",
        home.current,
        runCli(root, {
          agentDefaultOutputFormat: "json",
          analyticsLayer: mockAnalytics().layer,
        }),
      ).pipe(Effect.exit);
      const exit =
        scenario === "held-layer-release"
          ? yield* Effect.gen(function* () {
              const fiber = yield* run.pipe(Effect.forkChild);
              yield* Deferred.await(releaseStarted);
              const duringRelease = out.stdoutText;
              yield* Deferred.succeed(allowRelease, undefined);
              const exit = yield* Fiber.join(fiber);
              expect(duringRelease).toBe("");
              return exit;
            }).pipe(Effect.ensuring(Deferred.succeed(allowRelease, undefined)))
          : yield* run;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(attempts).toEqual([
        scenario === "held-layer-release" ? 0 : scenario === "warning" ? 1 : 7,
      ]);
      if (scenario === "warning") {
        expect(out.stderrText).toBe("Cleanup warning: restoration rejected\n");
        expect(out.stdoutText).toBe('{"value":"done"}\n');
      } else if (scenario === "partial-write") {
        expect(out.stdoutText).toBe('{"value":');
      } else if (scenario === "held-layer-release") {
        expect(out.stdoutText).toBe('{"value":"done"}\n');
      } else {
        expect(out.stdoutText).toBe("");
      }
      expect(out.failures).toEqual(
        scenario === "typed-failure" ||
          scenario === "cleanup-defect" ||
          scenario === "layer-release-defect"
          ? [expect.objectContaining({ message: "managed failure" })]
          : [],
      );
    } finally {
      process.argv = argv;
      processState.exit = undefined;
      processState.output = undefined;
    }
  }),
);
