#!/usr/bin/env bun
import {
  runHostProcessIfDispatched,
  runNativeProcessIfDispatched,
} from "@supabase/stack/internal/dispatch";

const argv = process.argv.slice(2);
const dispatched =
  (await runHostProcessIfDispatched(argv)) ||
  (await runNativeProcessIfDispatched(argv));
if (!dispatched && (argv.includes("--help") || argv.includes("-h"))) {
  process.stdout.write(
    "Usage: supabase-startup-api --action start|stop|destroy --runtime native|docker --project PATH --state-root PATH --cache-root PATH [--mode default|eager] [--stack-id ID]\n",
  );
} else if (!dispatched) {
  await import("./startup-api-runner.ts");
}
