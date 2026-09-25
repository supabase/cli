#!/usr/bin/env bun
import {
  runHostProcessIfDispatched,
  runNativeProcessIfDispatched,
} from "@supabase/stack/internal/dispatch";
import { Effect } from "effect";
import { startupTrace } from "./command-internal/startup-trace.ts";

const argv = process.argv.slice(2);
if (!(await runHostProcessIfDispatched(argv)) && !(await runNativeProcessIfDispatched(argv))) {
  if (process.env.SUPABASE_STARTUP_TRACE_FILE !== undefined)
    Effect.runSync(startupTrace("cli.process.begin"));
  await import("./cli/main.ts");
}
