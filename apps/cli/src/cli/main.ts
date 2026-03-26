#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { ProjectConfigStore } from "@supabase/config";
import { SupabaseApiClient } from "@supabase/api/effect";
import { unixHttpClientLayer } from "@supabase/stack";
import { Cause, Effect, Exit, Fiber, Layer, Stdio } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { root } from "./root.ts";
import { skillWriterLayer } from "../agents/skill-writer.layer.ts";
import { Credentials } from "../auth/credentials.service.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { normalizeCause } from "../output/normalize-error.ts";
import type { OutputFormat } from "../output/types.ts";
import { Output } from "../output/output.service.ts";
import { cliConfigLayer } from "../config/cli-config.layer.ts";
import { projectHomeLayer } from "../config/project-home.layer.ts";
import { ProjectLocalServiceVersions } from "../config/project-local-service-versions.service.ts";
import { projectContextLayer } from "../config/project-context.layer.ts";
import { ProjectLinkState } from "../config/project-link-state.service.ts";
import { processControlLayer } from "../runtime/process-control.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
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

function cliProgramFor(args: ReadonlyArray<string>) {
  const runtimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  const fallbackCommandLayer = Layer.mergeAll(
    // Root command env inference currently leaks some subcommand-provided services.
    Layer.succeed(Credentials, {
      getAccessToken: Effect.die("unexpected root credentials access"),
      saveAccessToken: () => Effect.die("unexpected root credentials write"),
      deleteAccessToken: Effect.die("unexpected root credentials deletion"),
    }),
    Layer.succeed(ProjectLinkState, {
      load: Effect.die("unexpected root project link state access"),
      save: () => Effect.die("unexpected root project link state write"),
      clear: Effect.die("unexpected root project link state clear"),
    }),
    Layer.succeed(ProjectLocalServiceVersions, {
      load: Effect.die("unexpected root project local service versions access"),
    }),
    Layer.succeed(ProjectConfigStore, {
      load: () => Effect.die("unexpected root project config access"),
      loadFile: () => Effect.die("unexpected root project config file access"),
      save: () => Effect.die("unexpected root project config write"),
    }),
    Layer.succeed(SupabaseApiClient, {
      execute: () => Effect.die("unexpected root platform api client access"),
    }),
  );
  return Command.runWith(root, { version: "0.1.0" })(args).pipe(
    Effect.provide(formatterLayerFor(args)),
    Effect.provide(skillWriterLayer.pipe(Layer.provide(BunServices.layer))),
    Effect.provide(
      tracingLayer.pipe(Layer.provide(BunServices.layer), Layer.provide(runtimeLayer)),
    ),
    Effect.provide(
      cliConfigLayer.pipe(Layer.provide(projectContextLayer), Layer.provide(runtimeLayer)),
    ),
    Effect.provide(
      projectHomeLayer.pipe(
        Layer.provide(
          cliConfigLayer.pipe(Layer.provide(projectContextLayer), Layer.provide(runtimeLayer)),
        ),
        Layer.provide(
          projectContextLayer.pipe(Layer.provide(runtimeLayer), Layer.provide(BunServices.layer)),
        ),
        Layer.provide(runtimeLayer),
        Layer.provide(BunServices.layer),
      ),
    ),
    Effect.provide(
      projectContextLayer.pipe(Layer.provide(runtimeLayer), Layer.provide(BunServices.layer)),
    ),
    Effect.provide(runtimeLayer),
    Effect.provide(fallbackCommandLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(BunServices.layer),
  );
}

const args = await Effect.runPromise(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.args;
  }).pipe(Effect.provide(BunServices.layer)),
);

const useGlobalSignalInterrupt = !args.includes("start");
const cliProgram = cliProgramFor(args);

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

const handledProgram = (
  program: Effect.Effect<unknown, unknown, never>,
): Effect.Effect<never, never, never> =>
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
    return yield* processControl.exit(0);
  }).pipe(
    Effect.provide(outputLayerFor(outputFormatFor(args))),
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
