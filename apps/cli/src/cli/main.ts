#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Stdio } from "effect";
import { runCli } from "../shared/cli/run.ts";
import { upgradeNoticeHook } from "../command-internal/upgrade-notice.ts";
import { analyticsLayer } from "../telemetry/analytics.layer.ts";
import { defaultCompleteDeps, tryComplete } from "./complete.ts";
import { resolveStackBackend } from "../commands/stack/stack-backend.ts";
import { resolveComputeEnabled } from "../commands/compute/compute-backend.ts";
import { rootCommandForFeatures } from "./root.ts";

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
const selectedRoot = rootCommandForFeatures(
  Exit.isSuccess(selectionExit)
    ? selectionExit.value
    : { stackBackend: "legacy", computeEnabled: false },
);
const selectionCause = Exit.isFailure(selectionExit) ? selectionExit.cause : undefined;

if (
  !(await tryComplete(
    defaultCompleteDeps(Exit.isSuccess(selectionExit) ? selectedRoot : undefined, selectionCause),
  ))
) {
  await runCli(selectedRoot, {
    analyticsLayer: analyticsLayer,
    afterSuccess: upgradeNoticeHook,
    ...(selectionCause ? { beforeParse: Effect.failCause(selectionCause) } : {}),
  });
}
