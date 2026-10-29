#!/usr/bin/env bun
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Layer, Stdio } from "effect";
import { FetchHttpClient } from "effect/http";
import { runCli } from "../shared/cli/run.ts";
import { upgradeNoticeHook } from "../command-internal/upgrade-notice.ts";
import { analyticsLayerFor } from "../telemetry/analytics.layer.ts";
import { defaultCompleteDeps, tryComplete } from "./complete.ts";
import { resolveProjectStateSelection } from "../command-internal/stack-backend.ts";
import { resolveComputeEnabled } from "../commands/experimental/compute/compute-backend.ts";
import { cliEntrypointForFeatures } from "./root.ts";

const args = await Effect.runPromise(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.args;
  }).pipe(Effect.provide(NodeServices.layer)),
);

const selectionExit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const { projectState, stackBackend } = yield* resolveProjectStateSelection({
      args,
      cwd: process.cwd(),
      env: process.env,
    });
    const computeEnabled = yield* resolveComputeEnabled({
      args,
      cwd: process.cwd(),
      env: process.env,
    });
    return { projectState, stackBackend, computeEnabled };
  }).pipe(Effect.provide(NodeServices.layer)),
);
const { rootCommand: selectedRoot, agentDefaultOutputFormat } = cliEntrypointForFeatures(
  Exit.isSuccess(selectionExit)
    ? selectionExit.value
    : { stackBackend: "legacy", computeEnabled: false },
  args,
);
const selectionCause = Exit.isFailure(selectionExit) ? selectionExit.cause : undefined;
const selectedProjectState = Exit.isSuccess(selectionExit)
  ? selectionExit.value.projectState
  : undefined;

if (
  !(await Effect.runPromise(
    tryComplete(
      defaultCompleteDeps(
        Exit.isSuccess(selectionExit) ? selectedRoot : undefined,
        selectionCause,
        selectedProjectState !== undefined && Exit.isSuccess(selectedProjectState)
          ? selectedProjectState.value
          : "legacy",
      ),
    ),
  ))
) {
  await Effect.runPromise(
    runCli(selectedRoot, {
      analyticsLayer: analyticsLayerFor(
        selectedProjectState !== undefined && Exit.isSuccess(selectedProjectState)
          ? selectedProjectState.value
          : "legacy",
      ).pipe(Layer.provide(FetchHttpClient.layer)),
      agentDefaultOutputFormat,
      afterSuccess: upgradeNoticeHook,
      ...(selectionCause ? { beforeParse: Effect.failCause(selectionCause) } : {}),
    }),
  );
}
