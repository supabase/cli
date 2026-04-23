import { BunServices } from "@effect/platform-bun";
import { ProjectConfigStore } from "@supabase/config";
import { unixHttpClientLayer } from "@supabase/stack";
import { Cause, Effect, Exit, Fiber, Layer, Stdio } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { CLI_VERSION } from "./version.ts";
import { Credentials } from "../../next/auth/credentials.service.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { normalizeCause } from "../output/normalize-error.ts";
import type { OutputFormat } from "../output/types.ts";
import { Output } from "../output/output.service.ts";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import { projectHomeLayer } from "../../next/config/project-home.layer.ts";
import { ProjectLocalServiceVersions } from "../../next/config/project-local-service-versions.service.ts";
import { projectContextLayer } from "../../next/config/project-context.layer.ts";
import { projectLinkStateLayer } from "../../next/config/project-link-state.layer.ts";
import { processControlLayer } from "../runtime/process-control.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";
import { CommandRuntime } from "../runtime/command-runtime.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { analyticsLayer } from "../telemetry/analytics.layer.ts";
import { telemetryRuntimeLayer } from "../telemetry/runtime.layer.ts";
import { tracingLayer } from "../telemetry/tracing.layer.ts";

function outputFormatFor(args: ReadonlyArray<string>): OutputFormat {
  const inline = args.find((arg) => arg.startsWith("--output-format="));
  if (inline) {
    const value = inline.slice("--output-format=".length);
    if (value === "json" || value === "stream-json" || value === "text") {
      return value;
    }
  }
  const formatIdx = args.indexOf("--output-format");
  const format = formatIdx !== -1 ? args[formatIdx + 1] : undefined;
  return format === "json" || format === "stream-json" ? format : "text";
}

function formatterLayerFor(args: ReadonlyArray<string>) {
  const format = outputFormatFor(args);
  return format === "json" || format === "stream-json"
    ? CliOutput.layer(jsonCliOutputFormatter())
    : Layer.empty;
}

function projectContextLayerFor(runtimeLayer: Layer.Layer<never>) {
  return projectContextLayer.pipe(Layer.provide(runtimeLayer), Layer.provide(BunServices.layer));
}

function cliConfigLayerFor(runtimeLayer: Layer.Layer<never>) {
  return cliConfigLayer.pipe(
    Layer.provide(projectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
  );
}

function projectHomeLayerFor(runtimeLayer: Layer.Layer<never>) {
  return projectHomeLayer.pipe(
    Layer.provide(cliConfigLayerFor(runtimeLayer)),
    Layer.provide(projectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
    Layer.provide(BunServices.layer),
  );
}

function cliProgramFor(rootCommand: Command.Command.Any, args: ReadonlyArray<string>) {
  const runtimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  const fallbackCommandLayer = Layer.mergeAll(
    // Root command env inference currently leaks some subcommand-provided services.
    Layer.succeed(Credentials, {
      getAccessToken: Effect.die("unexpected root credentials access"),
      saveAccessToken: () => Effect.die("unexpected root credentials write"),
      deleteAccessToken: Effect.die("unexpected root credentials deletion"),
    }),
    Layer.succeed(ProjectLocalServiceVersions, {
      load: Effect.die("unexpected root project local service versions access"),
    }),
    Layer.succeed(ProjectConfigStore, {
      load: () => Effect.die("unexpected root project config access"),
      loadFile: () => Effect.die("unexpected root project config file access"),
      save: () => Effect.die("unexpected root project config write"),
    }),
    Layer.succeed(
      CommandRuntime,
      CommandRuntime.of({
        commandPath: ["root"],
        commandRunId: "root-command-run-id",
      }),
    ),
  );
  return Command.runWith(rootCommand, { version: CLI_VERSION })(args).pipe(
    Effect.provide(formatterLayerFor(args)),
    Effect.provide(analyticsLayer),
    Effect.provide(tracingLayer),
    Effect.provide(telemetryRuntimeLayer),
    Effect.provide(cliConfigLayerFor(runtimeLayer)),
    Effect.provide(projectHomeLayerFor(runtimeLayer)),
    Effect.provide(projectContextLayerFor(runtimeLayer)),
    Effect.provide(projectLinkStateLayer),
    Effect.provide(runtimeLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(fallbackCommandLayer),
    Effect.provide(BunServices.layer),
  );
}

export async function runCli(rootCommand: Command.Command.Any) {
  const args = await Effect.runPromise(
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      return yield* stdio.args;
    }).pipe(Effect.provide(BunServices.layer)),
  );

  const useGlobalSignalInterrupt = !args.includes("start");
  const cliProgram = cliProgramFor(rootCommand, args);

  const signalAwareProgram = Effect.scoped(
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const cliFiber = yield* cliProgram.pipe(Effect.forkScoped);
      const outcome = yield* Effect.raceFirst(
        Fiber.await(cliFiber).pipe(Effect.map((exit) => ({ _tag: "cli" as const, exit }))),
        processControl
          .awaitSignal()
          .pipe(Effect.map((signal) => ({ _tag: "signal" as const, signal }))),
      );

      if (outcome._tag === "signal") {
        yield* Fiber.interrupt(cliFiber);
        return yield* Effect.interrupt;
      }

      return yield* outcome.exit;
    }),
  ).pipe(
    Effect.provide(processControlLayer),
    Effect.provide(runtimeInfoLayer),
    Effect.provide(ttyLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(BunServices.layer),
  );

  const handledRuntimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);

  const handledProgram = <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<never, unknown, never> =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const output = yield* Output;
      const exit = yield* program.pipe(Effect.exit);
      if (Exit.isFailure(exit)) {
        const interrupted = Cause.hasInterruptsOnly(exit.cause);
        if (!interrupted) {
          yield* output.fail(normalizeCause(exit.cause));
        }
        return yield* processControl.exit(interrupted ? 130 : 1);
      }
      const exitCode = yield* processControl.getExitCode;
      return yield* processControl.exit(exitCode ?? 0);
    }).pipe(
      Effect.provide(outputLayerFor(outputFormatFor(args))),
      Effect.provide(telemetryRuntimeLayer),
      Effect.provide(projectHomeLayerFor(handledRuntimeLayer)),
      Effect.provide(cliConfigLayerFor(handledRuntimeLayer)),
      Effect.provide(projectContextLayerFor(handledRuntimeLayer)),
      Effect.provide(processControlLayer),
      Effect.provide(runtimeInfoLayer),
      Effect.provide(ttyLayer),
      Effect.provide(unixHttpClientLayer),
      Effect.provide(BunServices.layer),
    );

  if (useGlobalSignalInterrupt) {
    await Effect.runPromise(handledProgram(signalAwareProgram));
  } else {
    await Effect.runPromise(handledProgram(cliProgram));
  }
}
