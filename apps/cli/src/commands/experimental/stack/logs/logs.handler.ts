import { DateTime, Effect, Option, Path, Stream } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { stripControlSequences } from "../../../../shared/output/strip-control-sequences.ts";
import {
  StackApi,
  StackTargetError,
  StackTargetResolver,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import { StackCommandLogsError } from "./logs.errors.ts";
import type { StackLogsFlags } from "./logs.command.ts";

const targetError = (cause: StackTargetError) =>
  new StackCommandLogsError({
    reason: cause.reason,
    message: cause.message,
    ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
    cause,
  });
const logsError = (cause: { readonly message: string }) =>
  new StackCommandLogsError({ reason: "unknown", message: cause.message, cause });

export const stackLogs = Effect.fn("experimental.stack.logs")(function* (flags: StackLogsFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const api = yield* StackApi;
    const resolver = yield* StackTargetResolver;
    yield* rejectStackOutput(yield* Effect.serviceOption(OutputFlag)).pipe(
      Effect.mapError(targetError),
    );
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(targetError));
    if (output.format === "json")
      return yield* new StackCommandLogsError({
        reason: "flags",
        message: "Live logs require text or stream-json output.",
        suggestion: "Use --output-format stream-json.",
      });
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        runtime: "auto",
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
      })
      .pipe(Effect.mapError(targetError));
    if (target.id === undefined)
      return yield* new StackCommandLogsError({
        reason: "flags",
        message: "No managed stack exists for the selected project.",
        suggestion: "Run supabase stack start first.",
      });
    const locations = {
      stateRoot: path.join(settings.supabaseHome, "stacks"),
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    };
    const discovery = yield* api.discover(locations).pipe(Effect.mapError(logsError));
    if (
      !discovery.some(({ definition, host }) => definition.id === target.id && host !== undefined)
    )
      return yield* new StackCommandLogsError({
        reason: "lifecycle",
        message: "No owner is reachable; live logs are unavailable.",
        suggestion: "Run supabase stack start first.",
      });
    const stack = yield* api.open({ ...locations, id: target.id }).pipe(Effect.mapError(logsError));
    const instances = yield* stack.services.list.pipe(Effect.mapError(logsError));
    const composition = yield* stack.composition.describe.pipe(Effect.mapError(logsError));
    const requested = Option.getOrUndefined(flags.service);
    const selected = instances.filter((instance) =>
      requested === undefined
        ? composition.members.some(({ id }) => id === instance.id)
        : instance.service === requested || instance.id === requested,
    );
    if (selected.length === 0)
      return yield* new StackCommandLogsError({
        reason: "flags",
        message:
          requested === undefined
            ? "The stack has no composition members to stream."
            : `No service matches ${requested}.`,
      });
    const streams = selected.map((instance) =>
      instance.logs.pipe(
        Stream.groupByKey((entry) => entry.stream),
        Stream.flatMap(
          ([channel, chunks]) =>
            chunks.pipe(
              Stream.map(({ bytes }) => bytes),
              Stream.decodeText,
              Stream.splitLines,
              Stream.map((line) => ({
                service: instance.service,
                instance_id: instance.id,
                stream: channel,
                line,
              })),
            ),
          { concurrency: 2 },
        ),
      ),
    );
    yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
      Stream.mapError(logsError),
      Stream.runForEach((entry) =>
        Effect.gen(function* () {
          const timestamp = DateTime.formatIso(yield* DateTime.now);
          if (output.format === "stream-json")
            yield* output.event({ type: "log-entry", timestamp, source: "live", ...entry });
          else
            yield* output.raw(
              `${timestamp} ${entry.service}/${entry.instance_id}/${entry.stream}: ${stripControlSequences(entry.line)}\n`,
            );
        }),
      ),
    );
  }).pipe(Effect.ensuring(telemetry.flush));
});
