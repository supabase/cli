#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { legacyAnalyticsLayer } from "../telemetry/legacy-analytics.layer.ts";
import { defaultCompletePassthroughDeps, tryCompletePassthrough } from "./complete-passthrough.ts";
import { legacyRoot } from "./root.ts";

if (!tryCompletePassthrough(defaultCompletePassthroughDeps())) {
  await runCli(legacyRoot, { analyticsLayer: legacyAnalyticsLayer });
}
