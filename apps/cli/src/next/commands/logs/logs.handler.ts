import { Crypto, Effect, FileSystem, Option, Path, Scope, Stream } from "effect";
import {
  findStack,
  openStack,
  type CapabilityName,
  type EffectStack,
  type FindStackOptions,
  type StackDescriptor,
  type StackId,
} from "@supabase/stack/effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { LogsFlags } from "./logs.command.ts";
import { UnsupportedLogsOutputFormatError } from "./logs.errors.ts";

type LogsRuntime =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

type LogsStack = Pick<EffectStack, "logs" | "followLogs">;
export interface LogsOperations {
  readonly findStack: (
    options: FindStackOptions,
  ) => Effect.Effect<Option.Option<StackDescriptor>, unknown, LogsRuntime>;
  readonly openStack: (id: StackId) => Effect.Effect<LogsStack, unknown, LogsRuntime>;
}

const defaultOperations: LogsOperations = { findStack, openStack };

export const logs = Effect.fnUntraced(function* (
  flags: LogsFlags,
  operations: LogsOperations = defaultOperations,
) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("Show local Supabase logs");
  if (output.format === "json") {
    return yield* new UnsupportedLogsOutputFormatError({
      detail: "The logs command does not support --output-format json.",
      suggestion: "Use --output-format stream-json for machine-readable streaming logs.",
    });
  }
  const descriptorOption = yield* operations.findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptorOption))
    return yield* output.outro("No local Supabase stack was found.");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* operations.openStack(descriptorOption.value.id);
      const capabilities: ReadonlyArray<CapabilityName> | undefined =
        flags.service.length === 0 ? undefined : flags.service;
      const retained = yield* stack.logs({ capabilities, tail: flags.tail });
      const history = retained.entries;
      const emit = (source: "history" | "live") => (entry: (typeof retained.entries)[number]) =>
        output.format === "stream-json"
          ? output.event({
              type: "log-entry",
              timestamp: entry.timestamp,
              service: entry.source,
              stream: entry.stream === "stdout" ? "stdout" : "stderr",
              line: entry.message,
              source,
            })
          : output.info(`[${entry.source}] ${entry.message}`);
      yield* Effect.forEach(history, emit("history"), { discard: true });
      if (!flags.noFollow) {
        yield* stack
          .followLogs({ capabilities, cursor: retained.cursor })
          .pipe(Stream.runForEach(emit("live")));
      }
    }),
  );
  yield* output.outro("Finished showing local Supabase logs.");
});
