#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Stdio } from "effect";
import { runCli } from "../shared/cli/run.ts";
import { legacyUpgradeNoticeHook } from "../command-internal/legacy-upgrade-notice.ts";
import { legacyAnalyticsLayer } from "../telemetry/legacy-analytics.layer.ts";
import { legacyDefaultCompleteDeps, legacyTryComplete } from "./legacy-complete.ts";
import { legacyResolveExperimentalStackBackend } from "../commands/experimental/stack/stack-backend.ts";
import { legacyRoot, legacyRootForBackend } from "./root.ts";

const args = await Effect.runPromise(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.args;
  }).pipe(Effect.provide(BunServices.layer)),
);

const backendExit = await Effect.runPromiseExit(
  legacyResolveExperimentalStackBackend({ args, cwd: process.cwd(), env: process.env }).pipe(
    Effect.provide(BunServices.layer),
  ),
);
if (Exit.isFailure(backendExit)) {
  await runCli(legacyRoot, {
    analyticsLayer: legacyAnalyticsLayer,
    afterSuccess: legacyUpgradeNoticeHook,
    beforeParse: Effect.failCause(backendExit.cause),
  });
} else {
  const root = legacyRootForBackend(backendExit.value);
  if (!(await legacyTryComplete(legacyDefaultCompleteDeps(root)))) {
    await runCli(root, {
      analyticsLayer: legacyAnalyticsLayer,
      afterSuccess: legacyUpgradeNoticeHook,
    });
  }
}
