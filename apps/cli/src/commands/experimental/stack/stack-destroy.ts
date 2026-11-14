import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";
import type { DeletedStack, StackError } from "@supabase/stack/effect";
import { MachineErrorContext } from "../../../shared/output/machine-error-context.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { resolveYes } from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { stackUploadsDir } from "../../../command-internal/stack-config.ts";
import { StackApi } from "../../../command-internal/stack-target.ts";
import { StackCommandDestroyError } from "./destroy/destroy.errors.ts";

const destroyError = (id: string) => (cause: StackError) =>
  cause.reason === "runtime-unavailable"
    ? new StackCommandDestroyError({
        reason: "runtime",
        message: cause.message,
        suggestion: `Start the container engine, then run "supabase stack destroy --stack-id ${id} --yes" again; nothing was removed.`,
        cause,
      })
    : new StackCommandDestroyError({
        reason: "stack",
        message: cause.message,
        cause,
      });

export const stackLocations = (path: Path.Path, supabaseHome: string) => ({
  stateRoot: path.join(supabaseHome, "stacks"),
  cacheRoot: path.join(supabaseHome, "cache", "stack"),
});

/** How the confirmation names one registered stack. */
export const destroyScope = (id: string, projectRoot: string) =>
  `stack ${id} at ${projectRoot} and its owned data`;

/** A stack selected for destruction, resolved before confirmation. */
interface DestroyTarget {
  readonly id: string;
  readonly deleted: Option.Option<DeletedStack>;
  readonly scope: string;
  /** Runs right before this stack is destroyed; a message skips it with that warning. */
  readonly recheck?: Effect.Effect<Option.Option<string>>;
}

interface DestroyOptions {
  readonly batch: boolean;
  /** Replaces the interactive question; the `--yes` notice still names every stack. */
  readonly question?: string;
  /** Counts a stack that another process destroyed meanwhile as destroyed. */
  readonly tolerateConcurrentDestroy?: boolean;
}

/**
 * Confirms once, then destroys each target and its Storage uploads, continuing past failures.
 * Returns the destroyed ids; a failed `batch` fails once, naming every failed stack. Untraced, so
 * its span annotations land on the calling command's span.
 */
export const destroyStacks = Effect.fnUntraced(function* (
  selected: ReadonlyArray<DestroyTarget>,
  options: DestroyOptions,
) {
  const { batch } = options;
  const output = yield* Output;
  const settings = yield* CommandSettings;
  const api = yield* StackApi;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const locations = stackLocations(path, settings.supabaseHome);
  const yes = yield* resolveYes;
  const tty = yield* Tty;
  if (!yes && (!tty.stdinIsTty || !output.interactive || output.format !== "text"))
    return yield* new StackCommandDestroyError({
      reason: "confirmation",
      message: "Destroying a stack requires confirmation; rerun with --yes.",
      suggestion: "Pass --yes when running non-interactively or in a machine-readable format.",
    });
  const scope = selected.map((entry) => entry.scope).join("; ");
  if (yes) yield* output.raw(`Permanently destroying ${scope}.\n`, "stderr");
  else {
    const question = options.question ?? `Permanently destroy ${scope}?`;
    const confirmed = yield* promptYesNo(output, false, question, false);
    if (!confirmed)
      return yield* new StackCommandDestroyError({
        reason: "cancelled",
        message: "Stack destruction was not confirmed.",
      });
  }
  const [outcomes, failed] = yield* Effect.partition(selected, ({ id, deleted, recheck }) =>
    Effect.gen(function* () {
      const skip = recheck === undefined ? Option.none<string>() : yield* recheck;
      if (Option.isSome(skip)) {
        yield* output.raw(`${skip.value}\n`, "stderr");
        return Option.none();
      }
      /* Destroy removes the registration last, so a stack no longer registered is gone. */
      const unlessGone = <A>(fallback: A) =>
        Effect.catch((error: StackError) =>
          options.tolerateConcurrentDestroy === true && Option.isNone(deleted)
            ? api.find({ stateRoot: locations.stateRoot, id }).pipe(
                Effect.map(Option.isNone),
                Effect.orElseSucceed(() => false),
                Effect.flatMap((gone) => (gone ? Effect.succeed(fallback) : Effect.fail(error))),
              )
            : Effect.fail(error),
        );
      const stack = Option.isSome(deleted)
        ? deleted
        : yield* api
            .open({ ...locations, id })
            .pipe(
              Effect.map(Option.some),
              unlessGone(Option.none()),
              Effect.mapError(destroyError(id)),
            );
      if (Option.isSome(stack)) {
        const destroying = yield* output.task(`Destroying stack ${id}...`);
        yield* stack.value.destroy.pipe(
          unlessGone(undefined),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? destroying.clear
              : Cause.hasInterruptsOnly(exit.cause)
                ? destroying.cancel()
                : destroying.fail(Option.getOrUndefined(Exit.findErrorOption(exit))?.message),
          ),
          Effect.mapError(destroyError(id)),
        );
      }
      const uploads = stackUploadsDir(path, settings.supabaseHome, id);
      yield* fs.remove(uploads, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new StackCommandDestroyError({
              reason: "uploads",
              message: `Stack ${id} was destroyed, but its Storage uploads could not be removed: ${cause.message}`,
              suggestion: `Remove ${uploads} manually.`,
              cause,
            }),
        ),
      );
      if (!batch) yield* Effect.annotateCurrentSpan({ "stack.prompted": !yes });
      if (output.format === "text")
        yield* output.raw(
          Option.isSome(deleted)
            ? `Removed the containers stack ${id} left behind.\n`
            : `Stack ${id} destroyed.\n`,
        );
      return Option.some({ id });
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) => ({ id, error })),
    ),
  );
  const destroyed = outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []));
  if (batch)
    yield* Effect.annotateCurrentSpan({
      "stack.prompted": !yes,
      "stack.count": selected.length,
      "stack.destroyed_count": destroyed.length,
    });
  const [failure] = failed;
  if (failure !== undefined) {
    if (!batch) return yield* failure.error;
    /* A stack whose registration is gone counts as destroyed and cannot be retried. */
    const leftover = failed.filter(({ error }) => error.reason === "uploads");
    const retryable = failed.filter(({ error }) => error.reason !== "uploads");
    const machineErrorContext = yield* Effect.serviceOption(MachineErrorContext);
    if (Option.isSome(machineErrorContext))
      yield* machineErrorContext.value.set({
        destroyed_stacks: [...destroyed, ...leftover.map(({ id }) => ({ id }))],
      });
    const manual =
      leftover.length === 0 ? undefined : leftover.map(({ error }) => error.suggestion).join(" ");
    const retry = `"supabase stack destroy ${retryable.map(({ id }) => `--stack-id ${id}`).join(" ")} --yes"`;
    const runtime =
      retryable.length > 0 && retryable.every(({ error }) => error.reason === "runtime");
    const retrySuggestion = runtime
      ? `Start the container engine, then run ${retry} again; nothing was removed for those stacks.`
      : `Resolve each error, then run ${retry} to retry the stacks that failed.`;
    return yield* new StackCommandDestroyError({
      reason: retryable.length === 0 ? "uploads" : runtime ? "runtime" : "stack",
      message: `Failed to destroy ${failed.length} managed stack(s).`,
      detail: failed.map(({ id, error }) => `${id}: ${error.message}`).join("\n"),
      suggestion:
        retryable.length === 0
          ? manual
          : manual === undefined
            ? retrySuggestion
            : `${retrySuggestion} ${manual}`,
      // Telemetry classifies a batch by its first failure; `detail` lists every stack.
      cause: failure.error,
    });
  }
  return destroyed;
});
