#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { legacyAnalyticsLayer } from "../telemetry/legacy-analytics.layer.ts";
import { legacyRoot } from "./root.ts";

await runCli(legacyRoot, { analyticsLayer: legacyAnalyticsLayer });
