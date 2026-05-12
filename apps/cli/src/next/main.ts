#!/usr/bin/env bun
const forkedDaemonEntryPoint = process.argv[2];

if (
  forkedDaemonEntryPoint?.endsWith("/daemon-bun.ts") ||
  forkedDaemonEntryPoint?.endsWith("\\daemon-bun.ts")
) {
  const { runBunDaemon } = await import("@supabase/stack/daemon-bun");
  runBunDaemon();
} else {
  await import("./cli/main.ts");
}
