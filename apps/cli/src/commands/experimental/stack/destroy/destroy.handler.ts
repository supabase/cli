import { Effect, Match, Option } from "effect";
import { isStackError, isStackId, StackIdSchema } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag, legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { LegacyExperimentalStackDestroyError } from "./destroy.errors.ts";

export interface LegacyExperimentalStackDestroyFlags {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
}

export const legacyValidateExperimentalStackDestroyTarget = (
  flags: Pick<LegacyExperimentalStackDestroyFlags, "stack" | "stackId">,
) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new LegacyExperimentalStackDestroyError({
          reason: "flags",
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

const destroyError = (error: unknown): LegacyExperimentalStackDestroyError => {
  const stackError = isStackError(error) ? error : undefined;
  const reason =
    stackError === undefined
      ? "unknown"
      : Match.value(stackError).pipe(
          Match.tag("StackNotFoundError", "InvalidStackIdentityError", () => "flags" as const),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackRuntimeError",
            "StackCleanupError",
            "StackDestructionError",
            "StackUpgradeRequiredError",
            () => "lifecycle" as const,
          ),
          Match.tag(
            "InvalidStackConfigError",
            "StackStateFormatUnsupportedError",
            "InvalidProjectRootError",
            "StackStateInvalidError",
            () => "invalid-config" as const,
          ),
          Match.orElse(() => "unknown" as const),
        );
  return new LegacyExperimentalStackDestroyError({
    reason,
    message: stackError?.message ?? String(error),
    cause: error,
  });
};

const resolveTarget = Effect.fnUntraced(function* (
  flags: LegacyExperimentalStackDestroyFlags,
  projectRoot: string,
) {
  const api = yield* LegacyExperimentalStackApi;
  if (Option.isSome(flags.stackId)) {
    const id = flags.stackId.value;
    if (!isStackId(id))
      return yield* new LegacyExperimentalStackDestroyError({
        reason: "flags",
        message: "--stack-id must be a lowercase SHA-256 stack id",
      });
    return yield* api.inspectStack(id).pipe(
      Effect.map(({ descriptor }) => descriptor),
      Effect.mapError(destroyError),
    );
  }
  const found = yield* api
    .findStack({
      projectRoot,
      ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
    })
    .pipe(Effect.mapError(destroyError));
  if (Option.isNone(found)) {
    const label = Option.isSome(flags.stack) ? ` named "${flags.stack.value}"` : "";
    return yield* new LegacyExperimentalStackDestroyError({
      reason: "flags",
      message: `No managed stack${label} was found for this project.`,
      suggestion: "Choose an existing --stack name or omit --stack for the current project.",
    });
  }
  return found.value;
});

export const legacyExperimentalStackDestroy = Effect.fn("legacy.experimental.stack.destroy")(
  function* (flags: LegacyExperimentalStackDestroyFlags) {
    const output = yield* Output;
    const settings = yield* LegacyCliSettings;
    const api = yield* LegacyExperimentalStackApi;
    const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
    if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
      return yield* new LegacyExperimentalStackDestroyError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
        suggestion: "Use --output-format json or --output-format text.",
      });
    yield* legacyValidateExperimentalStackDestroyTarget(flags);
    const target = yield* resolveTarget(flags, settings.workdir);
    const yes = yield* legacyResolveYes;
    const tty = yield* Tty;
    if (!yes && (!tty.stdinIsTty || output.format !== "text"))
      return yield* new LegacyExperimentalStackDestroyError({
        reason: "confirmation",
        message: "Destroying a stack requires confirmation; rerun with --yes.",
        suggestion: "Pass --yes when running non-interactively or in a machine-readable format.",
      });
    const confirmed = yield* legacyPromptYesNo(
      output,
      yes,
      `Permanently destroy stack "${target.name}" at ${target.projectRoot} (${target.id}) and all of its data?`,
      false,
    );
    if (!confirmed)
      return yield* new LegacyExperimentalStackDestroyError({
        reason: "confirmation",
        message: "Stack destruction was not confirmed.",
      });
    const stack = yield* api
      .openStack(StackIdSchema.make(target.id))
      .pipe(Effect.mapError(destroyError));
    const destroying = yield* output.task(`Destroying stack ${target.id}...`);
    yield* stack.destroy().pipe(
      Effect.tapError((error) => destroying.fail(error.message)),
      Effect.tap(() => destroying.clear()),
      Effect.mapError(destroyError),
    );
    if (output.format === "text") yield* output.raw(`Stack ${target.id} destroyed.\n`);
    else yield* output.success("", { destroyed: true, id: target.id });
  },
);
