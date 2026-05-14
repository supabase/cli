#!/usr/bin/env bun
import {
  enableSupervisorSelfDispatchForCompiledBun,
  isSupervisorRuntimeRequested,
  runSupervisorRuntimeFromEnv,
} from "@supabase/process-compose";

enableSupervisorSelfDispatchForCompiledBun(import.meta.url);

if (isSupervisorRuntimeRequested()) {
  runSupervisorRuntimeFromEnv();
} else if (process.env.SUPABASE_STACK_RUN_DAEMON === "1") {
  const { runBunDaemon } = await import("@supabase/stack/daemon-bun");
  runBunDaemon();
} else {
  await import("./cli/main.ts");
}
