import { Cause, Clock, Effect, Exit, Option, Stdio } from "effect";
import { Param } from "effect/unstable/cli";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "../shared/runtime/command-runtime.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { GLOBAL_FLAGS, OutputFlag, globalFlagValues } from "../command-internal/global-flags.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { withAnalyticsContext } from "../shared/telemetry/analytics-context.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import {
  type CliErrorActionability,
  classifyCliErrorActionability,
  unknownProcessControlledFailureActionability,
} from "../shared/telemetry/error-actionability.ts";
import { DbAdvisorsFailOnError } from "../commands/db/advisors/advisors.errors.ts";
import { DbLintFailOnError } from "../commands/db/lint/lint.errors.ts";
import {
  EventCommandExecuted,
  PropDurationMs,
  PropExitCode,
  PropOutputFormat,
} from "../shared/telemetry/event-catalog.ts";
import {
  failureTelemetryPropertiesForCause,
  toFailureTelemetryProperties,
} from "../shared/telemetry/failure-metadata.ts";
import {
  RESOURCE_OUTPUT_FORMATS,
  InvalidOutputFormatError,
  invalidOutputFormatMessage,
} from "../command-internal/go-output-flag.ts";
import { TelemetryOutputFormat } from "./telemetry-output-format.service.ts";
import { IdentityStitch } from "../command-internal/identity-stitch.ts";
import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../command-internal/db-target-flags.ts";
import { unwrapToSingleParam } from "../command-internal/param-introspection.ts";

/**
 * Classifies a command that succeeded its Effect but recorded a nonzero exit code through
 * ProcessControl. `db lint`/`db advisors` do this in machine mode after a `--fail-on` trigger, to
 * keep the JSON payload on stdout intact, so their telemetry derives from the same typed error
 * their text mode raises.
 */
function processControlledFailureActionability(command: string): CliErrorActionability {
  if (command === "db lint") {
    return classifyCliErrorActionability(new DbLintFailOnError({ message: "" }));
  }
  if (command === "db advisors") {
    return classifyCliErrorActionability(new DbAdvisorsFailOnError({ message: "" }));
  }
  return unknownProcessControlledFailureActionability;
}

interface CommandTelemetryOptions<Flags extends Record<string, unknown> = never> {
  readonly analytics?: boolean;
  readonly flags?: Flags;
  // Flag names (kebab-case) whose values are safe to log verbatim. Boolean flag values are always
  // passed through regardless of this list.
  readonly safeFlags?: ReadonlyArray<string>;
  // A command's flag config record (the object passed to `Command.make`). Any
  // `Flag.choice`/`Flag.choiceWithValue` flag in it is treated as telemetry-safe automatically, so
  // enum flags don't need hand-listing in `safeFlags`. The three global choice flags (`--output`,
  // `--dns-resolver`, `--agent`) are covered separately via `GLOBAL_CHOICE_FLAG_NAMES` below.
  readonly config?: Record<string, Param.Any>;
  // The `-o`/`--output` values this command accepts. Defaults to the resource-command set; `db
  // query` overrides with `json|table|csv`. The shared global `OutputFlag` accepts the union of
  // every command's values, so this re-validates against the command's own narrower set. See
  // `go-output-flag.ts`.
  readonly outputFormats?: ReadonlyArray<string>;
  // Short-flag → canonical-flag-name map (e.g. `{ s: "schema" }`) for this command's own flags,
  // so a `-s public` invocation records the `schema` flag rather than `s`. Global shorthands
  // (`-o` for `--output`) are merged in automatically via `GLOBAL_SHORT_ALIASES` below.
  readonly aliases?: Readonly<Record<string, string>>;
}

/**
 * Rejects an out-of-enum `-o`/`--output` value before the command runs, so no
 * `cli_command_executed` event fires for a rejected flag. `OutputFlag` is read optionally, since
 * it's a root global in production but absent from focused wrapper tests. Exported so
 * experimental-gated commands can call it explicitly before `requireExperimental` — an invalid
 * `-o` must be reported ahead of a missing `--experimental` flag, not the other way around.
 */
export const validateOutputFormat = (allowed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flag = yield* Effect.serviceOption(OutputFlag);
    if (Option.isNone(flag) || Option.isNone(flag.value)) return;
    const value = flag.value.value;
    if (allowed.includes(value)) return;
    return yield* Effect.fail(
      new InvalidOutputFormatError({
        message: invalidOutputFormatMessage(value, allowed),
      }),
    );
  });

const REDACTED_VALUE = "<redacted>";
// Fallback `-o` → telemetry derivation for commands that don't record a resolved format in
// `TelemetryOutputFormat` (`db query` does, so its `json|table|csv` reports correctly there
// instead); this set only governs the fallback, where a non-machine `-o` (`table`/`pretty`)
// collapses to the resolved text format.
const GO_MACHINE_OUTPUT_FORMATS = new Set(["env", "json", "toml", "yaml", "csv"]);
const GO_OUTPUT_FORMATS = new Set([...GO_MACHINE_OUTPUT_FORMATS, "pretty"]);

function toCliFlagName(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function extractGoOutputFormat(args: ReadonlyArray<string>): string | undefined {
  let format: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--output" || arg === "-o") {
      const value = args[index + 1];
      if (value !== undefined && GO_OUTPUT_FORMATS.has(value)) {
        format = value;
      }
      index++;
      continue;
    }

    if (arg.startsWith("--output=") || arg.startsWith("-o=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (GO_OUTPUT_FORMATS.has(value)) {
        format = value;
      }
    }
  }

  return format;
}

function resolveOutputFormatForTelemetry(args: ReadonlyArray<string>, outputFormat: string) {
  const goOutputFormat = extractGoOutputFormat(args);
  if (goOutputFormat !== undefined && GO_MACHINE_OUTPUT_FORMATS.has(goOutputFormat)) {
    return goOutputFormat;
  }
  return outputFormat;
}

function extractChangedFlagNames(
  args: ReadonlyArray<string>,
  aliases: Readonly<Record<string, string>> = {},
): ReadonlyArray<string> {
  const used = new Set<string>();
  let skipNext = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    // Skip a token that was consumed as the value of the previous flag — even
    // when that token is `--` (pflag lets a value-taking flag consume `--`).
    if (skipNext) {
      skipNext = false;
      continue;
    }

    // End-of-options sentinel: pflag-style parsing stops at a bare `--`, so everything after it
    // is positional (e.g. `test db -- --linked` makes `--linked` a path arg, not a flag). Mirrors
    // `resolveDbTargetFlags`'s `--` handling.
    if (arg === "--") break;

    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const eqIdx = raw.indexOf("=");
      const flagName = eqIdx === -1 ? raw : raw.slice(0, eqIdx);
      const isBare = eqIdx === -1;
      if (flagName.length === 0) continue;
      used.add(flagName);
      // A bare value-consuming flag's next token is its value (pflag space-separated form) —
      // skip it so only the flag name itself is recorded, not the value that follows.
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(flagName)) {
        skipNext = true;
      }
      continue;
    }

    // Shorthand forms `-s`, `-s=value`, and `-svalue` all key off the first character after the
    // single dash; map it to the canonical flag name. Only declared aliases are resolved —
    // unknown shorthands are ignored.
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg[1];
      if (short === undefined) continue;
      const canonical = aliases[short];
      if (canonical !== undefined) used.add(canonical);
      // A bare short flag (`-s`, length 2) takes its value from the next token; attached forms
      // (`-svalue`, `-s=value`) carry it inline, so no skip is needed there.
      if (arg.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(short)) {
        skipNext = true;
      }
    }
  }

  return [...used].sort((left, right) => left.localeCompare(right));
}

function normalizeFlagValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!Option.isOption(value)) return value;
  if (Option.isNone(value)) return undefined;
  return normalizeFlagValue(value.value);
}

// Every `Flag.choice`/`Flag.choiceWithValue` flag is treated as telemetry-safe automatically —
// checks the unwrapped `Single`'s primitive `_tag`. Restricted to `kind === Param.flagKind` so a
// same-named `Argument.choice` positional can never be mistaken for a `--flag`.
function getChoiceFlagNames(config: Record<string, Param.Any> | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  if (config === undefined) return names;

  for (const param of Object.values(config)) {
    const single = unwrapToSingleParam(param);
    if (
      single !== undefined &&
      single.kind === Param.flagKind &&
      single.primitiveType._tag === "Choice"
    ) {
      names.add(single.name);
    }
  }
  return names;
}

// Short-flag → canonical-name entries for every global/persistent flag with a shorthand alias,
// derived from `GLOBAL_FLAGS` so it never drifts from that source of truth (today just `{ o:
// "output" }`). Merged ahead of each command's own `aliases` in `extractChangedFlagNames`, so a
// command's own alias still wins on conflict.
const GLOBAL_SHORT_ALIASES: Readonly<Record<string, string>> = (() => {
  const aliases: Record<string, string> = {};
  for (const globalFlag of GLOBAL_FLAGS) {
    const single = unwrapToSingleParam(globalFlag.flag);
    if (single === undefined) continue;
    for (const alias of single.aliases) {
      aliases[alias] = single.name;
    }
  }
  return aliases;
})();

/**
 * CLI-name set for every global/persistent flag that is itself a `Flag.choice`/
 * `Flag.choiceWithValue` (today `output`, `dns-resolver`, `agent`), derived from `GLOBAL_FLAGS`
 * the same way `GLOBAL_SHORT_ALIASES` is. Applied only to the global-fallback path in
 * `buildFlagsMap` (`!isFromHandler`): a command that registers its own differently-typed local
 * flag under the same CLI name (e.g. `db diff`'s local string `--output`) must pass that flag in
 * its own `flags` record so this global set is never consulted for it — otherwise the fallback
 * would report it verbatim even though it isn't actually a choice flag there.
 */
const GLOBAL_CHOICE_FLAG_NAMES: ReadonlySet<string> = getChoiceFlagNames(
  Object.fromEntries(GLOBAL_FLAGS.map((globalFlag) => [globalFlag.id, globalFlag.flag])),
);

function buildFlagsMap<Flags extends Record<string, unknown>>(options: {
  readonly flags: Flags | undefined;
  // Live global/persistent flag values, keyed by CLI flag name — the fallback source for a
  // changed flag the handler never declared locally (e.g. `debug`).
  readonly globalFlagValues: Record<string, unknown>;
  readonly safeFlagSet: ReadonlySet<string>;
  readonly changedFlagNames: ReadonlyArray<string>;
  readonly choiceFlagNames: ReadonlySet<string>;
}): Record<string, unknown> | undefined {
  const {
    flags,
    globalFlagValues: globalFlags,
    safeFlagSet,
    changedFlagNames,
    choiceFlagNames,
  } = options;
  if (changedFlagNames.length === 0) return undefined;

  const result: Record<string, unknown> = {};
  const handlerFlagsByCliName = new Map<string, unknown>();
  if (flags !== undefined) {
    for (const [key, value] of Object.entries(flags)) {
      handlerFlagsByCliName.set(toCliFlagName(key), value);
    }
  }

  for (const cliName of changedFlagNames) {
    // A command's own flag always wins over a global/persistent flag sharing the same CLI name
    // (e.g. `db diff`'s local `--output` file-path flag shadows the global `--output` enum) —
    // only fall back to the live global-flag value when the handler never declared this name.
    const isFromHandler = handlerFlagsByCliName.has(cliName);
    const rawValue = isFromHandler ? handlerFlagsByCliName.get(cliName) : globalFlags[cliName];
    const value = normalizeFlagValue(rawValue);

    // `safeFlagSet`/`choiceFlagNames` vouch for a value only when it actually came from this
    // command's own `flags` record — a value resolved from the global-flag fallback instead
    // consults `GLOBAL_CHOICE_FLAG_NAMES`, the global flag's own choice-ness, so it can't inherit
    // a different command's per-flag safe/choice annotation just because the CLI name matches.
    // Boolean values are always safe, regardless of source.
    const isSafe =
      typeof value === "boolean" ||
      (isFromHandler
        ? safeFlagSet.has(cliName) || choiceFlagNames.has(cliName)
        : GLOBAL_CHOICE_FLAG_NAMES.has(cliName));

    result[cliName] = isSafe ? (value ?? REDACTED_VALUE) : REDACTED_VALUE;
  }

  return result;
}

function withCommandTracingImplementation() {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const commandRuntime = yield* CommandRuntime;
      const command = getCommandRuntimeCommand(commandRuntime);

      return yield* Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          command_run_id: commandRuntime.commandRunId,
          command,
        });
        return yield* self;
      }).pipe(Effect.withSpan(getCommandRuntimeSpanName(commandRuntime)));
    });
}

function withCommandAnalyticsImplementation<Flags extends Record<string, unknown>>(
  options?: CommandTelemetryOptions<Flags>,
) {
  const safeFlagSet = new Set(options?.safeFlags ?? []);
  const choiceFlagNames = getChoiceFlagNames(options?.config);
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const commandRuntime = yield* CommandRuntime;
      const command = getCommandRuntimeCommand(commandRuntime);

      return yield* Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          command_run_id: commandRuntime.commandRunId,
          command,
        });

        const analytics = yield* Analytics;
        const output = yield* Output;
        const processControl = yield* ProcessControl;
        const stdio = yield* Stdio.Stdio;
        const args = yield* stdio.args;
        const startedAt = yield* Clock.currentTimeMillis;
        const changedFlagNames = extractChangedFlagNames(args, {
          ...GLOBAL_SHORT_ALIASES,
          ...options?.aliases,
        });
        const globalFlags = yield* globalFlagValues;
        const flags = buildFlagsMap({
          flags: options?.flags,
          globalFlagValues: globalFlags,
          safeFlagSet,
          changedFlagNames,
          choiceFlagNames,
        });
        const analyticsContext = {
          command_run_id: commandRuntime.commandRunId,
          command,
          flags,
        } as const;

        const exit = yield* self.pipe(withAnalyticsContext(analyticsContext), Effect.exit);
        const finishedAt = yield* Clock.currentTimeMillis;

        // A command that resolves its own `--output` (e.g. `db query`, defaulting `table`/`json`
        // by agent mode) records it here; read optionally so commands that don't provide the
        // cell keep the default derivation.
        const outputFormatCell = yield* Effect.serviceOption(TelemetryOutputFormat);
        const resolvedOutputFormat = Option.isSome(outputFormatCell)
          ? yield* outputFormatCell.value.get
          : Option.none<string>();
        // A handler can signal a non-zero exit without failing the Effect — `db lint`/`db
        // advisors` set `ProcessControl`'s exit code in json/stream-json mode after a `--fail-on`
        // trigger so the machine payload on stdout stays intact. Treat a non-zero process exit
        // code as 1 even when the Effect succeeded; otherwise fall back to the Effect's own exit.
        //
        // `config diff --exit-code` is the one exception: it sets exit code 2 to signal drift
        // without failing the Effect (`diff.handler.ts`'s own 0/1/2 convention — 2 means "drift
        // found", not "command failed"), so its real exit code is recorded truthfully instead of
        // collapsing into the process-controlled failure bucket below.
        const processExitCode = yield* processControl.getExitCode;
        const isConfigDiffDriftSignal =
          Exit.isSuccess(exit) && command === "config diff" && processExitCode === 2;
        const recordedExitCode = isConfigDiffDriftSignal
          ? 2
          : Exit.isFailure(exit) || (processExitCode !== undefined && processExitCode !== 0)
            ? 1
            : 0;

        // Reads the stitched distinct ID (if `StitchLogin` mutated it during the command) and
        // overrides `distinct_id` only for this post-run capture — the `analyticsContext`
        // wrapping the handler's in-flight events stays unchanged. `serviceOption` adds no `R`
        // requirement.
        const stitchService = yield* Effect.serviceOption(IdentityStitch);
        const stitchedDistinctId: Option.Option<string> = Option.flatMap(stitchService, (svc) => {
          const id = svc.stitchedDistinctId();
          return id === undefined ? Option.none() : Option.some(id);
        });
        const captureContext = Option.match(stitchedDistinctId, {
          onNone: () => analyticsContext,
          onSome: (distinct_id) => ({ ...analyticsContext, distinct_id }),
        });
        const failureMetadata = Exit.isFailure(exit)
          ? failureTelemetryPropertiesForCause(exit.cause)
          : recordedExitCode === 1
            ? toFailureTelemetryProperties(processControlledFailureActionability(command))
            : {};

        yield* analytics
          .capture(EventCommandExecuted, {
            [PropExitCode]: recordedExitCode,
            [PropDurationMs]: finishedAt - startedAt,
            [PropOutputFormat]: Option.isSome(resolvedOutputFormat)
              ? resolvedOutputFormat.value
              : resolveOutputFormatForTelemetry(args, output.format),
            ...failureMetadata,
          })
          .pipe(
            withAnalyticsContext(captureContext),
            // Best-effort: a capture failure or defect must never replace the command's own
            // result, but a fiber interruption (e.g. Ctrl+C during this trailing capture) must
            // still propagate.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
            ),
          );

        if (Exit.isFailure(exit)) {
          return yield* Effect.failCause(exit.cause);
        }
        return exit.value;
      }).pipe(Effect.withSpan(getCommandRuntimeSpanName(commandRuntime)));
    });
}

export function withCommandTelemetry(): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | InvalidOutputFormatError,
  R | Analytics | CommandRuntime | Stdio.Stdio | Output | ProcessControl
>;
export function withCommandTelemetry<Flags extends Record<string, unknown>>(
  options: CommandTelemetryOptions<Flags>,
): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | InvalidOutputFormatError,
  R | Analytics | CommandRuntime | Stdio.Stdio | Output | ProcessControl
>;
export function withCommandTelemetry<Flags extends Record<string, unknown>>(
  options?: CommandTelemetryOptions<Flags>,
) {
  const allowed = options?.outputFormats ?? RESOURCE_OUTPUT_FORMATS;
  const instrument =
    options?.analytics === false
      ? withCommandTracingImplementation()
      : withCommandAnalyticsImplementation(options);
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    // Validate the `-o` enum before instrumentation runs the handler, so a rejected flag fails
    // without emitting a `cli_command_executed` event.
    Effect.andThen(validateOutputFormat(allowed), instrument(self));
}
