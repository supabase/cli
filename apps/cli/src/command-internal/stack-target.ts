import {
  StackId,
  type SavedStack,
  type ServiceCreation,
  type StackError,
} from "@supabase/stack/effect";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { Flag, GlobalFlag } from "effect/cli";
import { CommandSettings } from "../config/command-settings.service.ts";
import { envValue } from "../shared/config/env-option.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { recordStackRuntimeTelemetry, type StackRuntime } from "./stack-runtime.ts";
import { currentShellPlatform, shellQuoteArgument } from "./shell-quote.ts";
import { currentStackBackend } from "./stack-backend.ts";

export { StackApi, stackApiLayer };

/** The target selected by the CLI adapter for one stack command. */
export interface StackTarget {
  readonly projectRoot: string;
  readonly id?: string;
  readonly name?: string;
  readonly runtime?: StackRuntime;
  readonly definition?: SavedStack;
  readonly hostRunning: boolean;
}

/** The target-resolution step that could not read the saved stack state or project root. */
export type StackTargetIssue =
  | "stack-discovery"
  | "stack-lookup"
  | "unreadable-stack"
  | "project-root";

const targetIssueSuffix = {
  "stack-discovery": "stack_discovery",
  "stack-lookup": "stack_lookup",
  "unreadable-stack": "unreadable_stack",
  "project-root": "project_root",
} as const;

export const stackTargetInvalidConfigActionability = (
  targetIssue: StackTargetIssue | undefined,
): CliErrorActionabilityDeclaration => ({
  ...actionability.invalidConfig,
  fingerprint_suffix: targetIssue === undefined ? "invalid_config" : targetIssueSuffix[targetIssue],
});

export class StackTargetError extends Data.TaggedError("ExperimentalStackTargetError")<{
  readonly message: string;
  readonly reason: "flags" | "invalid-config";
  readonly targetIssue?: StackTargetIssue;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "flags"
      ? { ...actionability.provideFlags, fingerprint_suffix: "flags" }
      : stackTargetInvalidConfigActionability(this.targetIssue);
  }
}

/** Rewraps a `StackTargetError` into a command's own error type, preserving its fields. */
export const mapTargetError =
  <E>(
    make: (props: {
      readonly reason: StackTargetError["reason"];
      readonly targetIssue?: StackTargetIssue;
      readonly message: string;
      readonly suggestion?: string;
      readonly cause: StackTargetError;
    }) => E,
  ) =>
  (error: StackTargetError): E =>
    make({
      reason: error.reason,
      ...(error.targetIssue === undefined ? {} : { targetIssue: error.targetIssue }),
      message: error.message,
      ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
      cause: error,
    });

/** A stack named by `--stack`/`--stack-id`, or by `SUPABASE_STACK`/`SUPABASE_STACK_ID`. */
interface StackSelector {
  readonly name?: string;
  readonly id?: string;
  /** Set when `SUPABASE_STACK_ID` chose the id, which then only selects a stack of this project. */
  readonly idFromEnv?: true;
}

interface StackTargetInput extends StackSelector {
  readonly projectRoot: string;
  readonly runtime: "auto" | StackRuntime;
}

interface StackTargetResolverShape {
  readonly resolve: (input: StackTargetInput) => Effect.Effect<StackTarget, StackTargetError>;
}

export class StackTargetResolver extends Context.Service<
  StackTargetResolver,
  StackTargetResolverShape
>()("supabase/experimental-stack/TargetResolver") {}

export const validateStackTarget = (input: {
  readonly stack?: string;
  readonly stackId?: string;
}): Effect.Effect<void, StackTargetError> =>
  input.stack !== undefined && input.stackId !== undefined
    ? Effect.fail(
        new StackTargetError({
          message: "--stack and --stack-id cannot be used together",
          reason: "flags",
        }),
      )
    : Effect.void;

const StackFlag = GlobalFlag.Setting("stack")({
  flag: Flag.String("stack").pipe(
    Flag.withDescription(
      "Select a local stack by name (defaults to SUPABASE_STACK, else the current project stack).",
    ),
    Flag.optional,
  ),
});

const StackIdFlag = GlobalFlag.Setting("stack-id")({
  flag: Flag.String("stack-id").pipe(
    Flag.withDescription(
      "Select a local stack by ID or unique ID prefix (defaults to SUPABASE_STACK_ID).",
    ),
    Flag.optional,
  ),
});

/** Registered on each leaf, or group, whose commands reach the project stack. */
export const STACK_SELECTOR_FLAGS = [StackFlag, StackIdFlag] as const;

/** The selector flags pick a local stack, so they never change which Management API calls run. */
export const STACK_SELECTOR_FLAG_NAMES = ["stack", "stack-id"] as const;

const selector = (name: string | undefined, id: string | undefined): StackSelector => ({
  ...(name === undefined ? {} : { name }),
  ...(id === undefined ? {} : { id }),
});

/** The services a command reads `--stack`/`--stack-id` from. */
export type StackSelectorFlags =
  | GlobalFlag.Setting.Identifier<"stack">
  | GlobalFlag.Setting.Identifier<"stack-id">;

/** Provides the selector services from a leaf that declares its own `--stack`/`--stack-id`. */
export const stackSelectorFlagsLayer = (flags: {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
}) =>
  Layer.mergeAll(Layer.succeed(StackFlag, flags.stack), Layer.succeed(StackIdFlag, flags.stackId));

/** For a command that reaches the project stack without a selector flag; `SUPABASE_STACK` still applies. */
export const noStackSelectorFlags = stackSelectorFlagsLayer({
  stack: Option.none(),
  stackId: Option.none(),
});

/** Snapshots `--stack`/`--stack-id` in a layer so the services it builds can provide them per call. */
export const captureStackSelectorFlags = Effect.gen(function* () {
  const stack = yield* StackFlag;
  const stackId = yield* StackIdFlag;
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(StackFlag, stack),
      Effect.provideService(StackIdFlag, stackId),
    );
});

/** The not-found message for a selection no saved stack matches, and the start that creates it. */
export const missingStackAdvice = (name: string | undefined) => {
  const named = name === undefined ? undefined : describeStackSelector({ name });
  return {
    message:
      named === undefined
        ? "No managed stack exists for the selected project."
        : `No managed stack named ${named.label} exists for this project.`,
    suggestion: `Run supabase stack start${named === undefined ? "" : ` ${named.flags}`} first.`,
  };
};

const nonEmptyEnv = (name: string) =>
  envValue(name).pipe(Effect.map((value) => (value === "" ? undefined : value)));

/** `selected`, or the stack `SUPABASE_STACK`/`SUPABASE_STACK_ID` select when it names none. */
const orEnvSelector = Effect.fnUntraced(function* (selected: StackSelector) {
  if (selected.name !== undefined || selected.id !== undefined) return selected;
  const name = yield* nonEmptyEnv("SUPABASE_STACK");
  const id = yield* nonEmptyEnv("SUPABASE_STACK_ID");
  if (name !== undefined && id !== undefined)
    return yield* new StackTargetError({
      message: "SUPABASE_STACK and SUPABASE_STACK_ID cannot be used together",
      reason: "flags",
      suggestion: "Unset one of them, or pass --stack or --stack-id to override both.",
    });
  return id === undefined ? selector(name, id) : { id, idFromEnv: true as const };
});

/** The stack `--stack`/`--stack-id` select, else the one `SUPABASE_STACK`/`SUPABASE_STACK_ID` select. */
export const selectStack = Effect.fnUntraced(function* (flags: {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
}) {
  const name = Option.getOrUndefined(flags.stack);
  const id = Option.getOrUndefined(flags.stackId);
  yield* validateStackTarget({ stack: name, stackId: id });
  return yield* orEnvSelector(selector(name, id));
});

/** {@link selectStack} for the `--stack`/`--stack-id` the command was run with. */
export const selectedStack = Effect.gen(function* () {
  return yield* selectStack({ stack: yield* StackFlag, stackId: yield* StackIdFlag });
});

/** The selector flags, with a leading space, that keep a printed command on the selected stack. */
export const selectedStackFlags = selectedStack.pipe(
  Effect.map((selected) => {
    const named = describeStackSelector(selected);
    return named === undefined ? "" : ` ${named.flags}`;
  }),
  Effect.orElseSucceed(() => ""),
);

/** The selector flag passed on the command line, if any; never requires the flags to be registered. */
export const passedStackSelectorFlag = Effect.gen(function* () {
  const stack = Option.flatten(yield* Effect.serviceOption(StackFlag));
  const stackId = Option.flatten(yield* Effect.serviceOption(StackIdFlag));
  return Option.isSome(stack) ? "--stack" : Option.isSome(stackId) ? "--stack-id" : undefined;
});

/** The legacy backend has no named stacks, so a selector flag there is an error, not a no-op. */
export const rejectStackSelectorOnLegacy = Effect.gen(function* () {
  const flag = yield* passedStackSelectorFlag;
  if (flag !== undefined && (yield* currentStackBackend).kind === "legacy")
    return yield* new StackTargetError({
      message: `${flag} requires the experimental stack backend.`,
      reason: "flags",
      suggestion:
        "Set SUPABASE_EXPERIMENTAL_STACK=1 or [experimental] stack = true in supabase/config.toml.",
    });
});

/** How errors name a selected stack, and the selector flags that keep a printed command on it. */
export const describeStackSelector = (selected: StackSelector) =>
  selected.name !== undefined
    ? {
        label: `"${selected.name}"`,
        flags: `--stack ${shellQuoteArgument(selected.name, currentShellPlatform())}`,
      }
    : selected.id !== undefined
      ? { label: selected.id, flags: `--stack-id ${selected.id}` }
      : undefined;

export const isStackId = Schema.is(StackId);
const STACK_ID_PREFIX = /^[0-9a-f]{4,64}$/;

const validateStackId = (id: string): Effect.Effect<string, StackTargetError> =>
  STACK_ID_PREFIX.test(id)
    ? Effect.succeed(id)
    : Effect.fail(
        new StackTargetError({
          message: `Stack ID ${id} must be a lowercase hexadecimal ID or a unique prefix of at least 4 characters`,
          reason: "flags",
          suggestion: "Copy the ID column from `supabase stack list`.",
        }),
      );

export const rejectStackOutput = (
  outputFlag: Option.Option<Option.Option<string>>,
): Effect.Effect<void, StackTargetError> =>
  Option.isSome(outputFlag) && Option.isSome(outputFlag.value)
    ? Effect.fail(
        new StackTargetError({
          message: "The legacy -o/--output flag is not supported here; use --output-format json.",
          reason: "flags",
          suggestion:
            "Use --output-format json, --output-format text, or --output-format stream-json.",
        }),
      )
    : Effect.void;

const stateError = (targetIssue: StackTargetIssue) => (cause: StackError) =>
  new StackTargetError({ message: cause.message, reason: "invalid-config", targetIssue, cause });

const runtimeForFlag = (runtime: "auto" | StackRuntime): StackTarget["runtime"] =>
  runtime === "auto" ? undefined : runtime;

const runtimeMatches = (
  saved: StackTarget["runtime"],
  requested: StackTarget["runtime"],
): boolean => requested === undefined || saved === requested;

/**
 * Resolves an existing stack by id, unique id prefix, or the identity of the project and stack name;
 * with neither selector, `SUPABASE_STACK`/`SUPABASE_STACK_ID` select it.
 */
export const stackTargetResolverLayer = Layer.effect(
  StackTargetResolver,
  Effect.gen(function* () {
    const settings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalProjectRoot = (projectRoot: string) =>
      fs.realPath(projectRoot).pipe(
        Effect.mapError(
          (cause) =>
            new StackTargetError({
              message: cause.message,
              reason: "invalid-config",
              targetIssue: "project-root",
              cause,
            }),
        ),
      );
    const findByIdPrefix = Effect.fn("StackTargetResolver.findByIdPrefix")(function* (
      stateRoot: string,
      prefix: string,
    ) {
      const unreadable: Array<{ readonly id: string; readonly error: Error }> = [];
      const matches = yield* stackApi
        .discover({
          stateRoot,
          idPrefix: prefix,
          onInvalidState: (id, error) => Effect.sync(() => unreadable.push({ id, error })),
        })
        .pipe(Effect.mapError(stateError("stack-discovery")));
      const matchedIds = [
        ...matches.map(({ definition }) => definition.id),
        ...unreadable.map(({ id }) => id),
      ];
      yield* Effect.annotateCurrentSpan({ "stack.id_prefix_matches": matchedIds.length });
      if (matchedIds.length > 1)
        return yield* new StackTargetError({
          message: `Stack id prefix ${prefix} matches ${matchedIds.length} stacks: ${matchedIds.join(", ")}`,
          reason: "flags",
          suggestion: "Pass more characters of one of the listed stack ids.",
        });
      const [invalid] = unreadable;
      if (invalid !== undefined)
        yield* stackApi
          .find({ stateRoot, id: invalid.id })
          .pipe(Effect.mapError(stateError("unreadable-stack")));
      return matches[0];
    });
    const resolve = Effect.fn("StackTargetResolver.resolve")(function* (
      requested: StackTargetInput,
    ) {
      const input = { ...requested, ...(yield* orEnvSelector(requested)) };
      const id = input.id === undefined ? undefined : yield* validateStackId(input.id);
      const requestedRuntime = runtimeForFlag(input.runtime);
      const stateRoot = path.join(settings.supabaseHome, "stacks");
      // Canonicalized before the lookup so a missing project root is not reported as unreadable state.
      const lookupRoot =
        id === undefined ? yield* canonicalProjectRoot(input.projectRoot) : undefined;
      const found =
        id === undefined || isStackId(id)
          ? yield* stackApi
              .find(
                id === undefined
                  ? {
                      stateRoot,
                      projectRoot: lookupRoot ?? input.projectRoot,
                      ...(input.name === undefined ? {} : { name: input.name }),
                    }
                  : { stateRoot, id },
              )
              .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(stateError("stack-lookup")))
          : yield* findByIdPrefix(stateRoot, id);
      if (id !== undefined && found === undefined)
        return yield* new StackTargetError({
          message: `Stack ${id}${input.idFromEnv === true ? " (from SUPABASE_STACK_ID)" : ""} was not found`,
          reason: "flags",
          suggestion: "Run `supabase stack list` to see managed stacks and their IDs.",
        });
      if (input.idFromEnv === true && found !== undefined) {
        /* An exported id survives `cd`; only an explicit --stack-id targets another project's stack. */
        const currentRoot = yield* canonicalProjectRoot(input.projectRoot);
        if (found.definition.identity.projectRoot !== currentRoot)
          return yield* new StackTargetError({
            message: `SUPABASE_STACK_ID selects stack ${found.definition.id} of ${found.definition.identity.projectRoot}, not of this project (${currentRoot}).`,
            reason: "flags",
            suggestion:
              "Unset SUPABASE_STACK_ID, or pass --stack-id to target that stack explicitly.",
          });
      }
      if (found !== undefined && !runtimeMatches(found.definition.runtime, requestedRuntime))
        return yield* new StackTargetError({
          message: `Requested runtime ${requestedRuntime} does not match existing stack runtime ${found.definition.runtime}`,
          suggestion:
            "Use --runtime auto to reuse the saved runtime, or omit --stack-id and choose a different --stack name.",
          reason: "flags",
        });
      const runtime = found?.definition.runtime ?? requestedRuntime;
      if (runtime !== undefined) yield* recordStackRuntimeTelemetry(runtime);
      // A new stack saves paths under the canonical root its identity derives from.
      const projectRoot =
        found?.definition.identity.projectRoot ??
        lookupRoot ??
        (yield* canonicalProjectRoot(input.projectRoot));
      return {
        projectRoot,
        ...(found === undefined ? {} : { id: found.definition.id, definition: found.definition }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(runtime === undefined ? {} : { runtime }),
        hostRunning: found?.host !== undefined,
      };
    });
    return StackTargetResolver.of({ resolve });
  }),
);

/** Groups companion services under their user-facing stack capability. */
export const stackCapabilityForService = (service: ServiceCreation["service"]) => {
  switch (service) {
    case "imgproxy":
      return "storage";
    case "pgmeta":
      return "studio";
    default:
      return service;
  }
};

/** Formats the failed per-service outcomes of a composition error, one `label: error` per line. */
export const failedOutcomesDetail = (
  cause: Partial<Pick<StackError, "outcomes">>,
  label: (id: string) => string = (id) => id,
): string | undefined => {
  const failed = cause.outcomes?.filter((outcome) => !outcome.succeeded) ?? [];
  return failed.length === 0
    ? undefined
    : failed.map((outcome) => `${label(outcome.id)}: ${outcome.error ?? "failed"}`).join("\n");
};
