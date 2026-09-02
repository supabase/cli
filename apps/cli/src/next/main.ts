#!/usr/bin/env bun
import { runSupervisorProcessIfDispatched } from "@supabase/stack/internal/supervisor";

const args = process.argv.slice(2);
if (!(await runSupervisorProcessIfDispatched(args))) {
  await import("./cli/main.ts");
}
