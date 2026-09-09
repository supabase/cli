#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Stdio } from "effect";
import { runCli } from "../shared/cli/run.ts";
import { upgradeNoticeHook } from "../command-internal/upgrade-notice.ts";
import { analyticsLayer } from "../telemetry/analytics.layer.ts";
import { defaultCompleteDeps, tryComplete } from "./complete.ts";
import { resolveStackBackend } from "../commands/experimental/stack/stack-backend.ts";
import { rootCommand, rootCommandForBackend } from "./root.ts";

const args = await Effect.runPromise(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.args;
  }).pipe(Effect.provide(BunServices.layer)),
);

const backendExit = await Effect.runPromiseExit(
  resolveStackBackend({ args, cwd: process.cwd(), env: process.env }).pipe(
    Effect.provide(BunServices.layer),
  ),
);
const selectedRoot =
  Exit.isSuccess(backendExit) && backendExit.value === "stack"
    ? rootCommandForBackend("stack")
    : rootCommand;
const completionRoot = Exit.isSuccess(backendExit) ? selectedRoot : undefined;

if (
  !(await tryComplete(
    defaultCompleteDeps(
      completionRoot,
      Exit.isFailure(backendExit) ? backendExit.cause : undefined,
    ),
  ))
) {
  await runCli(selectedRoot, {
    analyticsLayer: analyticsLayer,
    afterSuccess: upgradeNoticeHook,
    ...(Exit.isFailure(backendExit) ? { beforeParse: Effect.failCause(backendExit.cause) } : {}),
  });
}
