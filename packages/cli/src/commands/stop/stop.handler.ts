import { Effect } from "effect";
import { stopDaemon } from "@supabase/stack/internals";
import { CliConfig } from "../../config/cli-config.service.ts";
import { Output } from "../../output/output.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import type { StopFlags } from "./stop.command.ts";

export const stop = Effect.fnUntraced(function* (_flags: StopFlags) {
  const output = yield* Output;
  const cliConfig = yield* CliConfig;
  const runtimeInfo = yield* RuntimeInfo;

  yield* output.intro("Stopping local Supabase stack...");

  yield* stopDaemon({ cwd: runtimeInfo.cwd, home: cliConfig.supabaseHome });

  yield* output.success("Local Supabase stopped");
});
