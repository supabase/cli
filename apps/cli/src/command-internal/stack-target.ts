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

/** The value `--stack`, else `SUPABASE_STACK`, selects: a stack name of this project, else a stack ID. */
interface StackSelector {
  readonly stack?: string;
  /** Set when `SUPABASE_STACK` chose it, so as an ID it only selects a stack of this project. */
  readonly fromEnv?: true;
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

const StackFlag = GlobalFlag.Setting("stack")({
  flag: Flag.String("stack").pipe(
    Flag.withDescription(
      "Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).",
    ),
    Flag.optional,
  ),
});

/** Registered on each leaf, or group, whose commands reach the project stack. */
export const STACK_SELECTOR_FLAGS = [StackFlag] as const;

/** The selector flag picks a local stack, so it never changes which Management API calls run. */
export const STACK_SELECTOR_FLAG_NAMES = ["stack"] as const;

/** The service a command reads `--stack` from. */
export type StackSelectorFlags = GlobalFlag.Setting.Identifier<"stack">;

/** Provides the selector service from a leaf that declares its own `--stack`. */
export const stackSelectorFlagsLayer = (flags: { readonly stack: Option.Option<string> }) =>
  Layer.succeed(StackFlag, flags.stack);

/** For a command that reaches the project stack without a selector flag; `SUPABASE_STACK` still applies. */
export const noStackSelectorFlags = stackSelectorFlagsLayer({ stack: Option.none() });

/** Snapshots `--stack` in a layer so the services it builds can provide it per call. */
export const captureStackSelectorFlags = Effect.gen(function* () {
  const stack = yield* StackFlag;
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(StackFlag, stack));
});

/** For an ID-shaped value no stack matches: it was looked up as a name and as an ID, so creating a stack named after it is not the advice. */
export const unmatchedStackIdAdvice = (value: string | undefined) =>
  value !== undefined && STACK_ID_PREFIX.test(value)
    ? {
        message: `No managed stack is named "${value}" in this project or has that ID.`,
        suggestion: "Run `supabase stack list` to see managed stacks and their IDs.",
      }
    : undefined;

/** The not-found message for a selection no saved stack matches, and the start that creates it. */
export const missingStackAdvice = (name: string | undefined) => {
  const unmatched = unmatchedStackIdAdvice(name);
  if (unmatched !== undefined) return unmatched;
  const named = name === undefined ? undefined : describeStackSelector({ stack: name });
  return {
    message:
      named === undefined
        ? "No managed stack exists for the selected project."
        : `No managed stack named ${named.label} exists for this project.`,
    suggestion: `Run supabase stack start${named === undefined ? "" : ` ${named.flags}`} first.`,
  };
};

/** Whether `SUPABASE_STACK` may select a stack; an explicit target such as a URL turns it off. */
export const StackEnvSelection = Context.Reference<boolean>(
  "supabase/experimental-stack/StackEnvSelection",
  { defaultValue: () => true },
);

/** `selected`, or the stack `SUPABASE_STACK` selects when it names none. */
const orEnvSelector = Effect.fnUntraced(function* (selected: StackSelector) {
  if (selected.stack !== undefined || !(yield* StackEnvSelection)) return selected;
  const stack = yield* envValue("SUPABASE_STACK");
  return stack === undefined || stack === "" ? {} : { stack, fromEnv: true as const };
});

/** The stack `--stack` selects, else the one `SUPABASE_STACK` selects. */
export const selectStack = (stack: Option.Option<string>) =>
  orEnvSelector(Option.isSome(stack) ? { stack: stack.value } : {});

/** {@link selectStack} for the `--stack` the command was run with. */
export const selectedStack = Effect.gen(function* () {
  return yield* selectStack(yield* StackFlag);
});

/** The selector flag, with a leading space, that keeps a printed command on the selected stack. */
export const selectedStackFlags = selectedStack.pipe(
  Effect.map((selected) => {
    const named = describeStackSelector(selected);
    return named === undefined ? "" : ` ${named.flags}`;
  }),
  Effect.orElseSucceed(() => ""),
);

/** The selector flag passed on the command line, if any; never requires the flag to be registered. */
export const passedStackSelectorFlag = Effect.gen(function* () {
  const stack = Option.flatten(yield* Effect.serviceOption(StackFlag));
  return Option.isSome(stack) ? ("--stack" as const) : undefined;
});

/** The legacy backend has no named stacks, so `--stack` there is an error, not a no-op. */
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

/** `--stack <value>` for a printed command; a value starting with `-` is joined with `=` so it parses. */
const stackFlagArgument = (stack: string) => {
  const quoted = shellQuoteArgument(stack, currentShellPlatform());
  return stack.startsWith("-") ? `--stack=${quoted}` : `--stack ${quoted}`;
};

/** How errors name a selected stack, and the selector flag that keeps a printed command on it. */
export const describeStackSelector = (selected: StackSelector) =>
  selected.stack === undefined
    ? undefined
    : {
        label: `"${selected.stack}"`,
        flags: stackFlagArgument(selected.stack),
      };

export const isStackId = Schema.is(StackId);
const STACK_ID_PREFIX = /^[0-9a-f]{4,64}$/;

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
 * Resolves the stack the selector names: a stack name of this project and branch first, then an
 * ID or unique ID prefix, so a name always wins. With no selector, `SUPABASE_STACK` selects it.
 * A value that matches nothing comes back as the name of a stack that does not exist yet.
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
    /* `envRoot` is the project an ID from `SUPABASE_STACK` must belong to: an export outlives `cd`. */
    const findById = Effect.fn("StackTargetResolver.findById")(function* (
      stateRoot: string,
      id: string,
      envRoot: string | undefined,
    ) {
      const unreadable: Array<string> = [];
      const matches = isStackId(id)
        ? Option.toArray(
            yield* stackApi
              .find({ stateRoot, id })
              .pipe(Effect.mapError(stateError("stack-lookup"))),
          )
        : yield* stackApi
            .discover({
              stateRoot,
              idPrefix: id,
              /* An unreadable stack cannot be attributed to the env's project, so it is skipped then. */
              onInvalidState: (invalidId) =>
                Effect.sync(() => {
                  if (envRoot === undefined) unreadable.push(invalidId);
                }),
            })
            .pipe(Effect.mapError(stateError("stack-discovery")));
      const own =
        envRoot === undefined
          ? matches
          : matches.filter(({ definition }) => definition.identity.projectRoot === envRoot);
      /* Other projects' stacks still make a prefix ambiguous when none of this project's match it. */
      const candidates = own.length > 0 ? own : matches;
      const matchedIds = [...candidates.map(({ definition }) => definition.id), ...unreadable];
      yield* Effect.annotateCurrentSpan({ "stack.id_prefix_matches": matchedIds.length });
      if (matchedIds.length > 1)
        return yield* new StackTargetError({
          message: `Stack id prefix ${id} matches ${matchedIds.length} stacks: ${matchedIds.join(", ")}`,
          reason: "flags",
          suggestion: "Pass more characters of one of the listed stack ids.",
        });
      const [elsewhere] = own.length > 0 ? [] : matches;
      if (elsewhere !== undefined)
        return yield* new StackTargetError({
          message: `SUPABASE_STACK selects stack ${elsewhere.definition.id} of ${elsewhere.definition.identity.projectRoot}, not of this project (${envRoot}).`,
          reason: "flags",
          suggestion: `Unset SUPABASE_STACK, or pass --stack ${elsewhere.definition.id} to target that stack explicitly.`,
        });
      const [invalid] = unreadable;
      if (invalid !== undefined)
        yield* stackApi
          .find({ stateRoot, id: invalid })
          .pipe(Effect.mapError(stateError("unreadable-stack")));
      return own[0];
    });
    const resolve = Effect.fn("StackTargetResolver.resolve")(function* (
      requested: StackTargetInput,
    ) {
      const input = { ...requested, ...(yield* orEnvSelector(requested)) };
      const requestedRuntime = runtimeForFlag(input.runtime);
      const stateRoot = path.join(settings.supabaseHome, "stacks");
      const asId =
        input.stack !== undefined && STACK_ID_PREFIX.test(input.stack) ? input.stack : undefined;
      const currentRoot = canonicalProjectRoot(input.projectRoot);
      /* An explicit ID reaches its stack from anywhere, even when the project root is missing. */
      const lookupRoot =
        asId !== undefined && input.fromEnv !== true
          ? Option.getOrUndefined(yield* Effect.option(currentRoot))
          : yield* currentRoot;
      const byName =
        lookupRoot === undefined
          ? undefined
          : yield* stackApi
              .find({
                stateRoot,
                projectRoot: lookupRoot,
                ...(input.stack === undefined ? {} : { name: input.stack }),
              })
              .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(stateError("stack-lookup")));
      /* An exported ID survives `cd`; only an explicit --stack reaches another project's stack. */
      const byId =
        byName === undefined && asId !== undefined
          ? yield* findById(stateRoot, asId, input.fromEnv === true ? lookupRoot : undefined)
          : undefined;
      const found = byName ?? byId;
      if (found !== undefined && !runtimeMatches(found.definition.runtime, requestedRuntime))
        return yield* new StackTargetError({
          message: `Requested runtime ${requestedRuntime} does not match existing stack runtime ${found.definition.runtime}`,
          suggestion:
            "Use --runtime auto to reuse the saved runtime, or choose a different --stack name.",
          reason: "flags",
        });
      const runtime = found?.definition.runtime ?? requestedRuntime;
      if (runtime !== undefined) yield* recordStackRuntimeTelemetry(runtime);
      return {
        // A new stack saves paths under the canonical root its identity derives from.
        projectRoot: found?.definition.identity.projectRoot ?? lookupRoot ?? (yield* currentRoot),
        ...(found === undefined ? {} : { id: found.definition.id, definition: found.definition }),
        ...(byId === undefined && input.stack !== undefined ? { name: input.stack } : {}),
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
