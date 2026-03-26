import { connectLayer, Stack } from "@supabase/stack/effect";
import { Effect, Stream } from "effect";
import { CliConfig } from "../../config/cli-config.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { Output } from "../../output/output.service.ts";
import { ProcessControl } from "../../runtime/process-control.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import type { LogsFlags } from "./logs.command.ts";
import { UnsupportedLogsOutputFormatError } from "./logs.errors.ts";

type LogsOutput = {
  readonly format: "text" | "json" | "stream-json";
  readonly info: (message: string) => Effect.Effect<void>;
  readonly event: (event: {
    readonly type: "log-entry";
    readonly timestamp: string;
    readonly service: string;
    readonly stream: "stdout" | "stderr";
    readonly line: string;
    readonly source: "history" | "live";
  }) => Effect.Effect<void>;
};

type LogEntry = {
  readonly timestamp: number;
  readonly service: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
};

function emitLogEntry(
  output: LogsOutput,
  entry: LogEntry,
  source: "history" | "live",
): Effect.Effect<void> {
  if (output.format === "stream-json") {
    return output.event({
      type: "log-entry",
      timestamp: new Date(entry.timestamp).toISOString(),
      service: entry.service,
      stream: entry.stream,
      line: entry.line,
      source,
    });
  }
  return output.info(`[${entry.service}] ${entry.line}`);
}

export const logs = Effect.fnUntraced(function* (flags: LogsFlags) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const output = yield* Output;
      const cliConfig = yield* CliConfig;
      const projectHome = yield* ProjectHome;
      const processControl = yield* ProcessControl;
      const runtimeInfo = yield* RuntimeInfo;

      yield* output.intro("Show local Supabase logs");

      if (output.format === "json") {
        return yield* new UnsupportedLogsOutputFormatError({
          detail: "The logs command does not support --output-format json.",
          suggestion: "Use --output-format stream-json for machine-readable streaming logs.",
        });
      }

      const layer = yield* connectLayer({
        cwd: runtimeInfo.cwd,
        cacheRoot: cliConfig.supabaseHome,
        projectDir: projectHome.projectRoot,
        projectStateRoot: projectHome.projectHomeDir,
        name: flags.stack,
      });
      const stack = yield* Effect.provide(Stack.asEffect(), layer);
      const services = flags.service.length === 0 ? undefined : flags.service;
      const history = flags.tail > 0 ? yield* stack.logHistoryAll(flags.tail, services) : [];
      const historyStream = Stream.fromIterable(history).pipe(
        Stream.runForEach((entry) => emitLogEntry(output, entry, "history")),
      );

      if (flags.noFollow) {
        yield* historyStream;
        yield* output.outro("Finished showing local Supabase logs.");
        return yield* processControl.exit(0);
      }

      const liveStream = stack
        .subscribeAllLogs(services)
        .pipe(Stream.runForEach((entry) => emitLogEntry(output, entry, "live")));

      yield* historyStream;
      yield* Effect.raceFirst(
        liveStream,
        processControl
          .awaitSignal()
          .pipe(Effect.flatMap((signal) => processControl.exit(signal === "SIGINT" ? 130 : 0))),
      );
    }),
  );
});
