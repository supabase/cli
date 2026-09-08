#!/usr/bin/env bun
import { runCli } from "../shared/cli/run.ts";
import { upgradeNoticeHook } from "../command-internal/upgrade-notice.ts";
import { analyticsLayer } from "../telemetry/analytics.layer.ts";
import { defaultCompleteDeps, tryComplete } from "./complete.ts";
import { rootCommand } from "./root.ts";

if (!(await tryComplete(defaultCompleteDeps(rootCommand)))) {
  await runCli(rootCommand, {
    analyticsLayer: analyticsLayer,
    afterSuccess: upgradeNoticeHook,
  });
}
