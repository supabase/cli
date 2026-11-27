import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Runtime,
  Schema,
  Scope,
} from "effect";
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
  withLegacyOutputHandler,
  withManagedHandler,
} from "../../command-internal/command-executor.ts";
import { OutputFormatFlag } from "../../command-internal/global-flags.ts";
import { StdoutClosedError } from "../output/errors.ts";
import { withJsonErrorHandling } from "../output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { Output } from "../output/output.service.ts";
import { commandRuntimeLayer } from "../runtime/command-runtime.layer.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { runCli } from "./run.ts";

const processState = vi.hoisted(() => ({
  control: undefined as ProcessControl["Service"] | undefined,
  output: undefined as Layer.Layer<Output> | undefined,
}));

// @effect-diagnostics-next-line asyncFunction:off -- Vitest loads dependencies in the hoisted factory.
vi.mock("../output/output.layer.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../output/output.layer.ts")>();
  return {
    ...original,
    outputLayerFor: (format: Parameters<typeof original.outputLayerFor>[0]) =>
      processState.output ?? original.outputLayerFor(format),
  };
});

// @effect-diagnostics-next-line asyncFunction:off -- Vitest loads dependencies in the hoisted factory.
vi.mock("../runtime/process-control.layer.ts", async () => {
  const { Layer } = await import("effect");
  const { ProcessControl } = await import("../runtime/process-control.service.ts");
  return {
    processControlLayer: Layer.sync(ProcessControl, () => {
      if (processState.control === undefined) throw new Error("Missing test process control");
      return processState.control;
    }),
  };
});

const home = useTempWorkdir("supabase-managed-output-");
const managedError = Object.assign(new Error("managed failure"), { [Runtime.errorExitCode]: 7 });
const report = [expect.objectContaining({ message: "managed failure" })];
const writerDiagnostic = "Failed to write command output.\n";
const result = { value: "done" };
const RequiredResource = Context.Service<string>("test/RequiredResource");

const gate = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const open = Deferred.succeed(release, undefined);
  return {
    hold: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    awaitHeld: Deferred.await(started),
    open,
  };
});

type OutputHarness = ReturnType<typeof mockOutput>;

const runCommand = (options: {
  readonly owner?: "managed" | "legacy" | "legacy baseline";
  readonly handler: Effect.Effect<
    typeof result,
    Error,
    ProcessControl | Scope.Scope | Output | string
  >;
  readonly required?: Layer.Layer<string, Error>;
  readonly out: OutputHarness;
  readonly format?: "text" | "json";
  readonly writer?: Layer.Layer<Output>;
  readonly beforeDrain?: Effect.Effect<void>;
  readonly finishDrain?: Effect.Effect<void>;
  readonly duringDrain?: (signal: Effect.Effect<void>) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { out, format = "json", writer = out.layer } = options;
    const drain = yield* gate;
    const sigint = yield* Deferred.make<"SIGINT">();
    const signalWon = yield* Deferred.make<void>();
    const attempts: number[] = [];
    let exitCode: number | undefined;
    const handler = () => options.handler;
    const runtime = {
      required: options.required ?? Layer.succeed(RequiredResource, "done"),
      completion: Layer.mergeAll(
        writer,
        commandExecutorLayer,
        mockLinkedProjectCacheLayer,
        mockTelemetryStateLayer,
        commandRuntimeLayer(["test"]),
      ),
    };
    const command = Command.make("supabase").pipe(Command.withGlobalFlags([OutputFormatFlag]));
    const root =
      options.owner === "legacy baseline"
        ? command.pipe(
            Command.withHandler(() =>
              handler().pipe(Effect.scoped, withCommandTelemetry({}), withJsonErrorHandling),
            ),
            Command.provide(Layer.merge(runtime.required, runtime.completion)),
          )
        : options.owner === "legacy"
          ? command.pipe(withLegacyOutputHandler({ handler, runtime }))
          : command.pipe(
              withManagedHandler({
                output: Schema.Struct({ value: Schema.String }),
                handler,
                runtime,
              }),
            );
    const argv = process.argv;
    process.argv = [argv[0] ?? "bun", "supabase", "--output-format", format];
    processState.output = writer;
    processState.control = ProcessControl.of({
      awaitSignal: () => Deferred.await(sigint),
      awaitShutdown: Effect.never,
      // The runner holds SIGHUP only after its signal race chooses the signal branch.
      holdSignals: (signals) =>
        signals.includes("SIGHUP")
          ? Deferred.succeed(signalWon, undefined).pipe(Effect.asVoid)
          : Effect.void,
      setExitCode: (code) =>
        Effect.sync(() => {
          exitCode = code;
        }),
      getExitCode: Effect.sync(() => exitCode),
      exit: (code) => Effect.sync(() => attempts.push(code)).pipe(Effect.andThen(Effect.interrupt)),
    });
    try {
      const run = withEnvVar(
        "SUPABASE_HOME",
        home.current,
        runCli(root, {
          agentDefaultOutputFormat: "json",
          analyticsLayer: Layer.merge(
            mockAnalytics().layer,
            Layer.effectDiscard(
              Effect.addFinalizer(() =>
                drain.hold.pipe(Effect.andThen(options.finishDrain ?? Effect.void)),
              ),
            ),
          ),
        }),
      ).pipe(Effect.exit);
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* run.pipe(Effect.forkScoped);
          yield* Effect.gen(function* () {
            yield* options.beforeDrain ?? Effect.void;
            yield* drain.awaitHeld;
            expect(attempts).toEqual([]);
            yield* (
              options.duringDrain?.(
                Deferred.succeed(sigint, "SIGINT").pipe(Effect.andThen(Deferred.await(signalWon))),
              ) ?? Effect.void
            );
          }).pipe(Effect.ensuring(drain.open));
          return yield* Fiber.join(fiber);
        }),
      );
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      return attempts;
    } finally {
      process.argv = argv;
      processState.control = undefined;
      processState.output = undefined;
    }
  });

it.live.each(["closed stdout", "failed writer", "release defect", "acquisition failure"] as const)(
  "preserves legacy root failure routing for %s",
  (scenario) =>
    Effect.gen(function* () {
      const observe = (owner: "legacy baseline" | "legacy") =>
        Effect.gen(function* () {
          const out = mockOutput({ format: "json" });
          const phases: string[][] = [];
          const writer = Layer.effect(
            Output,
            Effect.map(Output, (output) => ({
              ...output,
              fail: (error) =>
                output
                  .fail(error)
                  .pipe(
                    Effect.andThen(
                      error.message !== managedError.message
                        ? Effect.void
                        : scenario === "closed stdout"
                          ? Effect.die(new StdoutClosedError())
                          : scenario === "failed writer"
                            ? Effect.die(new Error("stdout write failed"))
                            : Effect.void,
                    ),
                  ),
            })),
          ).pipe(Layer.provide(out.layer));
          const attempts = yield* runCommand({
            owner,
            out,
            writer,
            required:
              scenario === "acquisition failure"
                ? Layer.effect(RequiredResource, Effect.fail(managedError))
                : undefined,
            handler:
              scenario === "release defect"
                ? Effect.gen(function* () {
                    const output = yield* Output;
                    yield* Effect.addFinalizer(() => Effect.die(managedError));
                    yield* output.raw('{"legacy":true}\n');
                    return result;
                  })
                : Effect.fail(managedError),
            duringDrain: () =>
              Effect.sync(() => phases.push(out.failures.map(({ message }) => message))),
          });
          return {
            attempts,
            stdout: out.stdoutText,
            stderr: out.stderrText,
            phases,
            failures: out.failures.map(({ message }) => message),
          };
        });
      const baseline = yield* observe("legacy baseline");
      expect(baseline).toEqual({
        attempts: [scenario === "failed writer" ? 1 : 7],
        stdout: scenario === "release defect" ? '{"legacy":true}\n' : "",
        stderr: "",
        phases: [
          scenario === "closed stdout" || scenario === "failed writer" ? ["managed failure"] : [],
        ],
        failures:
          scenario === "failed writer"
            ? ["managed failure", "stdout write failed"]
            : ["managed failure"],
      });
      expect(yield* observe("legacy")).toEqual(baseline);
    }),
);

it.live("releases required services before writing a machine result", () =>
  Effect.gen(function* () {
    const out = mockOutput({ format: "json" });
    const release = yield* gate;
    const attempts = yield* runCommand({
      out,
      handler: Effect.map(RequiredResource, (value) => ({ value })),
      required: Layer.effect(
        RequiredResource,
        Effect.acquireRelease(Effect.succeed("done"), () => release.hold),
      ),
      beforeDrain: Effect.gen(function* () {
        yield* release.awaitHeld;
        expect(out.stdoutText).toBe("");
      }).pipe(Effect.ensuring(release.open)),
      duringDrain: () => Effect.sync(() => expect(out.failures).toEqual([])).pipe(Effect.asVoid),
    });
    expect(out.stdoutText).toBe('{"value":"done"}\n');
    expect(out.failures).toEqual([]);
    expect(attempts).toEqual([0]);
  }),
);

it.live.each(["json", "text"] as const)(
  "reports a typed %s failure on the right side of the drain",
  (format) =>
    Effect.gen(function* () {
      const out = mockOutput({ format });
      const attempts = yield* runCommand({
        out,
        format,
        handler: Effect.fail(managedError),
        duringDrain: () =>
          Effect.sync(() => {
            expect(out.failures).toEqual(format === "json" ? report : []);
          }),
      });
      expect(out.stdoutText).toBe("");
      expect(out.failures).toEqual(report);
      expect(attempts).toEqual([7]);
    }),
);

it.live("suppresses the pending text failure if SIGINT wins during the analytics drain", () =>
  Effect.gen(function* () {
    const out = mockOutput({ format: "text" });
    const attempts = yield* runCommand({
      out,
      format: "text",
      handler: Effect.fail(managedError),
      duringDrain: (signal) => signal,
    });
    expect(attempts).toEqual([130]);
    expect(out.failures).toEqual([]);
    expect(out.stdoutText).toBe("");
    expect(out.stderrText).toBe("");
  }),
);

it.live.each([
  { name: "closed stdout", defect: new StdoutClosedError(), stderr: "", code: 7 },
  {
    name: "full stdout",
    defect: Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
    stderr: writerDiagnostic,
    code: 1,
  },
])("does not retry the machine error writer on $name", ({ defect, stderr, code }) =>
  Effect.gen(function* () {
    const out = mockOutput({ format: "json" });
    const writer = Layer.effect(
      Output,
      Effect.map(Output, (output) => ({
        ...output,
        fail: (error) => output.fail(error).pipe(Effect.andThen(Effect.die(defect))),
      })),
    ).pipe(Layer.provide(out.layer));
    const attempts = yield* runCommand({
      out,
      writer,
      handler: Effect.fail(managedError),
      duringDrain: () =>
        Effect.sync(() => {
          expect(out.failures).toEqual(report);
          expect(out.stderrText).toBe("");
        }),
    });
    expect(out.stdoutText).toBe("");
    expect(out.failures).toEqual(report);
    expect(out.stderrText).toBe(stderr);
    expect(attempts).toEqual([code]);
  }),
);

it.live.each(["working", "failing"] as const)(
  "keeps a partial machine result and its exit code with %s stderr",
  (stderr) =>
    Effect.gen(function* () {
      const out = mockOutput({ format: "json" });
      const diagnosticAttempts: string[] = [];
      const writer = Layer.effect(
        Output,
        Effect.map(Output, (output) => ({
          ...output,
          result: () => output.raw('{"value":').pipe(Effect.andThen(Effect.die(managedError))),
          raw: (text, stream) => {
            if (stream !== "stderr") return output.raw(text, stream);
            diagnosticAttempts.push(text);
            return stderr === "working"
              ? output.raw(text, stream)
              : Effect.die(new Error("stderr unavailable"));
          },
        })),
      ).pipe(Layer.provide(out.layer));
      const attempts = yield* runCommand({
        out,
        writer,
        handler: Effect.succeed(result),
        duringDrain: () =>
          Effect.sync(() => {
            expect(out.failures).toEqual([]);
            expect(out.stderrText).toBe("");
          }),
      });
      expect(out.stdoutText).toBe('{"value":');
      expect(out.failures).toEqual([]);
      expect(diagnosticAttempts).toEqual([writerDiagnostic]);
      expect(out.stderrText).toBe(stderr === "working" ? writerDiagnostic : "");
      expect(attempts).toEqual([7]);
    }),
);

it.live("does not label an analytics release defect as a writer defect after a result", () =>
  Effect.gen(function* () {
    const out = mockOutput({ format: "json" });
    const attempts = yield* runCommand({
      out,
      handler: Effect.succeed(result),
      finishDrain: Effect.die(managedError),
    });
    expect(out.stdoutText).toBe('{"value":"done"}\n');
    expect(out.failures).toEqual([]);
    expect(out.stderrText).toBe("");
    expect(attempts).toEqual([7]);
  }),
);

it.live("preserves a cleanup warning exit code and still writes the result", () =>
  Effect.gen(function* () {
    const out = mockOutput({ format: "json" });
    const attempts = yield* runCommand({
      out,
      handler: Effect.gen(function* () {
        const control = yield* ProcessControl;
        const writer = yield* Output;
        yield* Effect.addFinalizer(() =>
          writer
            .raw("Cleanup warning: restoration rejected\n", "stderr")
            .pipe(Effect.andThen(control.setExitCode(1))),
        );
        return result;
      }),
      duringDrain: () =>
        Effect.sync(() => {
          expect(out.failures).toEqual([]);
        }),
    });
    expect(out.stderrText).toBe("Cleanup warning: restoration rejected\n");
    expect(out.stdoutText).toBe('{"value":"done"}\n');
    expect(out.failures).toEqual([]);
    expect(attempts).toEqual([1]);
  }),
);

it.live.each(["handler finalizer", "required service release"] as const)(
  "reports a %s defect as a command failure after the drain",
  (phase) =>
    Effect.gen(function* () {
      const out = mockOutput({ format: "json" });
      const die = Effect.die(managedError);
      const attempts = yield* runCommand({
        out,
        required: Layer.effect(
          RequiredResource,
          Effect.acquireRelease(Effect.succeed("done"), () =>
            phase === "required service release" ? die : Effect.void,
          ),
        ),
        handler: (phase === "handler finalizer"
          ? Effect.addFinalizer(() => die)
          : Effect.void
        ).pipe(Effect.as(result)),
        duringDrain: () =>
          Effect.sync(() => {
            expect(out.failures).toEqual([]);
          }),
      });
      expect(out.failures).toEqual(report);
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("");
      expect(attempts).toEqual([7]);
    }),
);
