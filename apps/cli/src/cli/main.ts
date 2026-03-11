#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Fiber, Layer, Stdio } from "effect";
import { CliOutput } from "effect/unstable/cli";
import { cli } from "./root.ts";
import { skillWriterLayer } from "../agents/skill-writer.layer.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";
import { cliConfigLayer } from "../config/cli-config.layer.ts";
import { processControlLayer } from "../runtime/process-control.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { tracingLayer } from "../telemetry/tracing.layer.ts";

function formatterLayerFor(args: ReadonlyArray<string>) {
  const formatIdx = args.indexOf("--output-format");
  const format = formatIdx !== -1 ? args[formatIdx + 1] : undefined;
  return format === "json" || format === "stream-json"
    ? CliOutput.layer(jsonCliOutputFormatter())
    : Layer.empty;
}

function cliProgramFor(args: ReadonlyArray<string>) {
  const runtimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  return cli.pipe(
    Effect.provide(formatterLayerFor(args)),
    Effect.provide(skillWriterLayer.pipe(Layer.provide(BunServices.layer))),
    Effect.provide(
      tracingLayer.pipe(Layer.provide(BunServices.layer), Layer.provide(runtimeLayer)),
    ),
    Effect.provide(cliConfigLayer),
    Effect.provide(runtimeLayer),
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
  Effect.provide(BunServices.layer),
);

const startProgram = Effect.gen(function* () {
  const processControl = yield* ProcessControl;
  const exit = yield* cliProgram.pipe(Effect.exit);
  if (Exit.isFailure(exit)) {
    const code = Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
    if (!Cause.hasInterruptsOnly(exit.cause)) {
      yield* Console.error(Cause.pretty(exit.cause));
    }
    return yield* processControl.exit(code);
  }
  return yield* processControl.exit(0);
}).pipe(
  Effect.provide(processControlLayer),
  Effect.provide(runtimeInfoLayer),
  Effect.provide(ttyLayer),
  Effect.provide(BunServices.layer),
);

if (useGlobalSignalInterrupt) {
  await Effect.runPromise(signalAwareProgram);
} else {
  await Effect.runPromise(startProgram);
}
