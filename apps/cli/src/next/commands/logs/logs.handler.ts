import { Effect, Option, Stream } from "effect";
import { findStack, openStack } from "@supabase/stack/effect";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { LogsFlags } from "./logs.command.ts";
import { UnsupportedLogsOutputFormatError } from "./logs.errors.ts";

export const logs = Effect.fnUntraced(function* (flags: LogsFlags) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("Show local Supabase logs");
  if (output.format === "json") {
    return yield* new UnsupportedLogsOutputFormatError({
      detail: "The logs command does not support --output-format json.",
      suggestion: "Use --output-format stream-json for machine-readable streaming logs.",
    });
  }
  const descriptorOption = yield* findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptorOption))
    return yield* output.outro("No local Supabase stack was found.");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* openStack(descriptorOption.value.id);
      const stream = flags.noFollow
        ? stack.logs({ follow: false }).pipe(Stream.take(flags.tail))
        : stack.logs({ follow: true });
      yield* stream.pipe(
        Stream.runForEach((entry) =>
          output.format === "stream-json"
            ? output.success("", {
                type: "log-entry",
                timestamp: entry.timestamp,
                service: entry.source,
                stream: entry.stream,
                line: entry.message,
              })
            : output.info(`[${entry.source}] ${entry.message}`),
        ),
      );
    }),
  );
  yield* output.outro("Finished showing local Supabase logs.");
});
