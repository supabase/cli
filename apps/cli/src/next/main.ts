#!/usr/bin/env bun
if (process.env.SUPABASE_STACK_RUN_DAEMON === "1") {
  const { runBunDaemon } = await import("@supabase/stack/daemon-bun");
  runBunDaemon();
} else {
  await import("./cli/main.ts");
}
