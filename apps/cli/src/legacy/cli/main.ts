#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { legacyAnalyticsLayer } from "../telemetry/legacy-analytics.layer.ts";
import { legacyDefaultCompleteDeps, legacyTryComplete } from "./legacy-complete.ts";
import { legacyRoot } from "./root.ts";

if (!legacyTryComplete(legacyDefaultCompleteDeps(legacyRoot))) {
  await runCli(legacyRoot, { analyticsLayer: legacyAnalyticsLayer });
}
