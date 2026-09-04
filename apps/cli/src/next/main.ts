#!/usr/bin/env bun
import {
  runNativeProcessIfDispatched,
  runSupervisorProcessIfDispatched,
} from "@supabase/stack/internal/supervisor";

const args = process.argv.slice(2);
if (
  !(await runSupervisorProcessIfDispatched(args)) &&
  !(await runNativeProcessIfDispatched(args))
) {
  await import("./cli/main.ts");
}
