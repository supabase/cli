#!/usr/bin/env bun
import {
  enableSupervisorSelfDispatchForCompiledBun,
  isSupervisorRuntimeRequested,
  runSupervisorRuntimeFromEnv,
} from "@supabase/process-compose";
import { Config, ConfigProvider, Effect, Option } from "effect";

enableSupervisorSelfDispatchForCompiledBun(import.meta.url);

if (isSupervisorRuntimeRequested()) {
  runSupervisorRuntimeFromEnv();
} else if (
  Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string("SUPABASE_STACK_RUN_DAEMON")).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
        ),
      ),
    ),
  ) === "1"
) {
  const { runBunDaemon } = await import("@supabase/stack/daemon-bun");
  runBunDaemon();
} else {
  await import("./cli/main.ts");
}
