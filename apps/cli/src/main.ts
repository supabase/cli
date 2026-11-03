#!/usr/bin/env bun
import {
  runHostProcessIfDispatched,
  runNativeProcessIfDispatched,
} from "@supabase/stack/internal/dispatch";

const argv = process.argv.slice(2);
if (!(await runHostProcessIfDispatched(argv)) && !(await runNativeProcessIfDispatched(argv))) {
  await import("./cli/main.ts");
}
