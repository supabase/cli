#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { analyticsLayer } from "../../shared/telemetry/analytics.layer.ts";
import { nextRoot } from "./root.ts";

await runCli(nextRoot, { analyticsLayer });
