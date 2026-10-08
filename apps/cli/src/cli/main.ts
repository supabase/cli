#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Stdio } from "effect";
import { FetchHttpClient } from "effect/http";
import { runCli } from "../shared/cli/run.ts";
import { upgradeNoticeHook } from "../command-internal/upgrade-notice.ts";
import { analyticsLayer } from "../telemetry/analytics.layer.ts";
import { defaultCompleteDeps, tryComplete } from "./complete.ts";
import { resolveStackBackend } from "../command-internal/stack-backend.ts";
import { resolveComputeEnabled } from "../commands/experimental/compute/compute-backend.ts";
import { cliEntrypointForFeatures } from "./root.ts";

const args = await Effect.runPromise(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.args;
  }).pipe(Effect.provide(BunServices.layer)),
);

const selectionExit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const stackBackend = yield* resolveStackBackend({ args, cwd: process.cwd(), env: process.env });
    const computeEnabled = yield* resolveComputeEnabled({
      args,
      cwd: process.cwd(),
      env: process.env,
    });
    return { stackBackend, computeEnabled };
  }).pipe(Effect.provide(BunServices.layer)),
);
const { rootCommand: selectedRoot, agentDefaultOutputFormat } = cliEntrypointForFeatures(
  Exit.isSuccess(selectionExit)
    ? selectionExit.value
    : { stackBackend: "legacy", computeEnabled: false },
  args,
);
const selectionCause = Exit.isFailure(selectionExit) ? selectionExit.cause : undefined;

if (
  !(await tryComplete(
    defaultCompleteDeps(Exit.isSuccess(selectionExit) ? selectedRoot : undefined, selectionCause),
  ))
) {
  await Effect.runPromise(
    runCli(selectedRoot, {
      analyticsLayer: analyticsLayer.pipe(Layer.provide(FetchHttpClient.layer)),
      agentDefaultOutputFormat,
      afterSuccess: upgradeNoticeHook,
      ...(selectionCause ? { beforeParse: Effect.failCause(selectionCause) } : {}),
    }),
  );
}
