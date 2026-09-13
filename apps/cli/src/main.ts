#!/usr/bin/env bun
import {
  runNativeProcessIfDispatched,
  runSupervisorProcessIfDispatched,
} from "@supabase/stack/internal/supervisor";

const argv = process.argv.slice(2);
if (
  !(await runSupervisorProcessIfDispatched(argv)) &&
  !(await runNativeProcessIfDispatched(argv))
) {
  await import("./cli/main.ts");
}
