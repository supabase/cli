import { Effect, Stream } from "effect";
import { connectLayer, Stack } from "@supabase/stack/internals";
import { CliConfig } from "../../config/cli-config.service.ts";
import { Output } from "../../output/output.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import type { LogsFlags } from "./logs.command.ts";

export const logs = Effect.fnUntraced(function* (_flags: LogsFlags) {
  const output = yield* Output;
  const cliConfig = yield* CliConfig;
  const runtimeInfo = yield* RuntimeInfo;

  const layer = yield* connectLayer({ cwd: runtimeInfo.cwd, home: cliConfig.supabaseHome });
  const stack = yield* Effect.provide(Stack.asEffect(), layer);

  yield* stack
    .subscribeAllLogs()
    .pipe(Stream.runForEach((entry) => output.info(`[${entry.service}] ${entry.line}`)));
});
