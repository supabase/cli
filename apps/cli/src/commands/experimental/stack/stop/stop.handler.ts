import { Effect, Match, Option } from "effect";
import {
  isStackError,
  isStackId,
  StackIdSchema,
  type StackDescriptor,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { LegacyExperimentalStackStopError } from "./stop.errors.ts";

export interface LegacyExperimentalStackStopFlags {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
}

export const legacyValidateExperimentalStackStopTarget = (
  flags: Pick<LegacyExperimentalStackStopFlags, "stack" | "stackId">,
) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new LegacyExperimentalStackStopError({
          reason: "flags",
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

const stopError = (error: unknown): LegacyExperimentalStackStopError => {
  const stackError = isStackError(error) ? error : undefined;
  const classification =
    stackError === undefined
      ? { reason: "unknown" as const }
      : Match.value(stackError).pipe(
          Match.tag("StackNotFoundError", () => ({ reason: "flags" as const })),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackRuntimeError",
            "StackCleanupError",
            () => ({ reason: "lifecycle" as const }),
          ),
          Match.tag(
            "InvalidStackConfigError",
            "InvalidProjectRootError",
            "StackStateInvalidError",
            () => ({ reason: "invalid-config" as const }),
          ),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new LegacyExperimentalStackStopError({
    ...classification,
    message: stackError?.message ?? String(error),
    cause: error,
  });
};

const stoppedPayload = (id: StackDescriptor["id"]) => ({ id, lifecycle: "stopped" });

export const legacyExperimentalStackStop = Effect.fn("legacy.experimental.stack.stop")(function* (
  flags: LegacyExperimentalStackStopFlags,
) {
  const output = yield* Output;
  const settings = yield* LegacyCliSettings;
  const stackApi = yield* LegacyExperimentalStackApi;
  const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
  if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
    return yield* new LegacyExperimentalStackStopError({
      reason: "flags",
      message: "The legacy -o/--output flag is not supported here; use --output-format json.",
      suggestion: "Use --output-format json, --output-format text, or --output-format stream-json.",
    });
  yield* legacyValidateExperimentalStackStopTarget(flags);

  const id = Option.isSome(flags.stackId) ? flags.stackId.value : undefined;
  const targetOption =
    id === undefined
      ? yield* stackApi
          .findStack({
            projectRoot: settings.workdir,
            ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
          })
          .pipe(Effect.mapError(stopError))
      : yield* isStackId(id)
          ? Effect.succeed(
              Option.some({
                id: StackIdSchema.make(id),
                projectRoot: settings.workdir,
              }),
            )
          : Effect.fail(
              new LegacyExperimentalStackStopError({
                reason: "flags",
                message: "--stack-id must be a lowercase SHA-256 stack id",
              }),
            );
  if (Option.isNone(targetOption)) {
    if (Option.isSome(flags.stack))
      return yield* new LegacyExperimentalStackStopError({
        reason: "flags",
        message: `No managed stack named "${flags.stack.value}" was found for this project.`,
        suggestion: "Choose an existing --stack name or omit --stack for the current project.",
      });
    yield* output.success("No managed stack found for this context.", { found: false });
    return;
  }
  const target = targetOption.value;
  const stack = yield* stackApi.openStack(target.id).pipe(Effect.mapError(stopError));
  const stopping = yield* output.task(`Stopping stack ${target.id}...`);
  yield* stack.stop().pipe(
    Effect.tapError((error) => stopping.fail(error.message)),
    Effect.tap(() => stopping.succeed("Stack stopped.")),
    Effect.mapError(stopError),
  );
  if (output.format === "text") yield* output.raw(`Stack ${target.id} stopped.\n`);
  else yield* output.success("", stoppedPayload(target.id));
});
