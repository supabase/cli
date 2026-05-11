#!/usr/bin/env bun
import { runDaemonIfRequested } from "@supabase/stack";

// When `child_process.fork()` targets a compiled standalone binary, the
// daemon-entrypoint argv is silently ignored — the binary always runs its
// hardcoded entry. `forkDaemon` sets `SUPABASE_DAEMON_ENTRYPOINT` in that
// case so this dispatch can run the daemon in-process from the same binary.
if (!(await runDaemonIfRequested())) {
  await import("./cli/main.ts");
}
