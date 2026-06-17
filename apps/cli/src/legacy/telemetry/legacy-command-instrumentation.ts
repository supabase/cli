import { Clock, Effect, Exit, Option, Stdio } from "effect";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "../../shared/runtime/command-runtime.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { withAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  EventCommandExecuted,
  PropDurationMs,
  PropExitCode,
  PropOutputFormat,
} from "../../shared/telemetry/event-catalog.ts";
import { LegacyIdentityStitch } from "../shared/legacy-identity-stitch.ts";
import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../shared/legacy-db-target-flags.ts";

interface LegacyCommandInstrumentationOptions<Flags extends Record<string, unknown> = never> {
  readonly analytics?: boolean;
  readonly flags?: Flags;
  // Flag names (kebab-case) whose values are safe to log verbatim, mirroring
  // Go's `markFlagTelemetrySafe` annotation in cmd/root_analytics.go. Boolean
  // flag values are always passed through, matching Go's isBooleanFlag branch.
  readonly safeFlags?: ReadonlyArray<string>;
  // Short-flag → canonical-flag-name map (e.g. `{ s: "schema" }`). Go's
  // `changedFlags()` uses pflag's `Visit`, which reports the CANONICAL flag name
  // whether the user typed the long form (`--schema`) or the registered shorthand
  // (`-s`). Pass a command's shorthands here so a `-s public` invocation records
  // the `schema` flag in telemetry, matching Go (cmd/root_analytics.go:53-76).
  readonly aliases?: Readonly<Record<string, string>>;
}

const REDACTED_VALUE = "<redacted>";
const LEGACY_GO_MACHINE_OUTPUT_FORMATS = new Set(["env", "json", "toml", "yaml"]);
const LEGACY_GO_OUTPUT_FORMATS = new Set([...LEGACY_GO_MACHINE_OUTPUT_FORMATS, "pretty"]);

function toCliFlagName(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function extractLegacyGoOutputFormat(args: ReadonlyArray<string>): string | undefined {
  let format: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--output" || arg === "-o") {
      const value = args[index + 1];
      if (value !== undefined && LEGACY_GO_OUTPUT_FORMATS.has(value)) {
        format = value;
      }
      index++;
      continue;
    }

    if (arg.startsWith("--output=") || arg.startsWith("-o=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (LEGACY_GO_OUTPUT_FORMATS.has(value)) {
        format = value;
      }
    }
  }

  return format;
}

function resolveOutputFormatForTelemetry(args: ReadonlyArray<string>, outputFormat: string) {
  const goOutputFormat = extractLegacyGoOutputFormat(args);
  if (goOutputFormat !== undefined && LEGACY_GO_MACHINE_OUTPUT_FORMATS.has(goOutputFormat)) {
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

    // End-of-options sentinel: pflag stops parsing flags at a bare `--`, so
    // everything after it is positional (e.g. `test db -- --linked` makes
    // `--linked` a path arg). changedFlags() never sees those, so stop scanning.
    // Mirrors resolveLegacyDbTargetFlags's `--` handling.
    if (arg === "--") break;

    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const eqIdx = raw.indexOf("=");
      const flagName = eqIdx === -1 ? raw : raw.slice(0, eqIdx);
      const isBare = eqIdx === -1;
      if (flagName.length === 0) continue;
      used.add(flagName);
      // If this is a bare value-consuming flag, the next token is its value
      // (Go's pflag space-separated form). Skip it so it is not recorded as a
      // changed flag. This mirrors Go's pflag.Changed — only the flag name
      // itself is recorded, not the value token that follows it.
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(flagName)) {
        skipNext = true;
      }
      continue;
    }

    // pflag shorthand: `-s`, `-s=value`, and `-svalue` all key off the first
    // character after the single dash. Map it to the canonical flag name (Go's
    // `flag.Visit` reports the canonical name regardless of long/short form).
    // Only declared aliases are resolved; unknown shorthands are ignored.
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg[1];
      if (short === undefined) continue;
      const canonical = aliases[short];
      if (canonical !== undefined) used.add(canonical);
      // Bare short value-consuming flag (`-s` alone, length === 2): next token
      // is the value. Skip it. Attached forms (`-svalue`, `-s=value`, length > 2)
      // carry the value inline — no skip needed.
      if (arg.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(short)) {
        skipNext = true;
      }
    }
  }

  // Match Go's sort.Slice(...flag.Name < flag.Name) in changedFlags().
  return [...used].sort((left, right) => left.localeCompare(right));
}

function normalizeFlagValue(value: unknown): unknown | undefined {
  if (value === undefined) return undefined;
  if (!Option.isOption(value)) return value;
  if (Option.isNone(value)) return undefined;
  return normalizeFlagValue(value.value);
}

function buildFlagsMap<Flags extends Record<string, unknown>>(
  flags: Flags | undefined,
  safeFlagSet: ReadonlySet<string>,
  changedFlagNames: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
  if (changedFlagNames.length === 0) return undefined;

  const result: Record<string, unknown> = {};
  const handlerFlagsByCliName = new Map<string, unknown>();
  if (flags !== undefined) {
    for (const [key, value] of Object.entries(flags)) {
      handlerFlagsByCliName.set(toCliFlagName(key), value);
    }
  }

  for (const cliName of changedFlagNames) {
    const rawValue = handlerFlagsByCliName.get(cliName);
    const value = normalizeFlagValue(rawValue);

    if (safeFlagSet.has(cliName) || typeof value === "boolean") {
      result[cliName] = value ?? REDACTED_VALUE;
      continue;
    }

    result[cliName] = REDACTED_VALUE;
  }

  return result;
}

function withLegacyCommandTracingImplementation() {
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

function withLegacyCommandAnalyticsImplementation<Flags extends Record<string, unknown>>(
  options?: LegacyCommandInstrumentationOptions<Flags>,
) {
  const safeFlagSet = new Set(options?.safeFlags ?? []);
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
        const changedFlagNames = extractChangedFlagNames(args, options?.aliases);
        const flags = buildFlagsMap(options?.flags, safeFlagSet, changedFlagNames);
        const analyticsContext = {
          command_run_id: commandRuntime.commandRunId,
          command,
          flags,
        } as const;

        const exit = yield* self.pipe(withAnalyticsContext(analyticsContext), Effect.exit);
        const finishedAt = yield* Clock.currentTimeMillis;

        // Go records the telemetry exit code from the real process exit code
        // (`cmd/root.go:177` -> `exitCode(err)`), which is 1 whenever the command
        // exits non-zero. A handler can signal a non-zero exit WITHOUT failing the
        // Effect — `db lint`/`db advisors` set `ProcessControl`'s exit code in
        // json/stream-json mode after a `--fail-on` trigger so the machine payload
        // on stdout stays intact. Treat a non-zero process exit code as 1 even when
        // the Effect succeeded, matching Go; otherwise fall back to the Effect exit.
        const processExitCode = yield* processControl.getExitCode;
        const recordedExitCode =
          Exit.isFailure(exit) || (processExitCode !== undefined && processExitCode !== 0) ? 1 : 0;

        // Go's Execute() reads s.distinctID() AFTER the command handler runs
        // (cmd/root.go:177), which returns the just-stitched gotrue id when
        // StitchLogin mutated the live telemetry service during the command.
        // Mirror that: read LegacyIdentityStitch optionally (serviceOption adds no
        // R requirement) and override distinct_id only for the post-run capture,
        // leaving the analyticsContext that wrapped the handler's in-flight events
        // unchanged.
        const stitchService = yield* Effect.serviceOption(LegacyIdentityStitch);
        const stitchedDistinctId: Option.Option<string> = Option.flatMap(stitchService, (svc) => {
          const id = svc.stitchedDistinctId();
          return id === undefined ? Option.none() : Option.some(id);
        });
        const captureContext = Option.match(stitchedDistinctId, {
          onNone: () => analyticsContext,
          onSome: (distinct_id) => ({ ...analyticsContext, distinct_id }),
        });

        yield* analytics
          .capture(EventCommandExecuted, {
            [PropExitCode]: recordedExitCode,
            [PropDurationMs]: finishedAt - startedAt,
            [PropOutputFormat]: resolveOutputFormatForTelemetry(args, output.format),
          })
          .pipe(withAnalyticsContext(captureContext));

        if (Exit.isFailure(exit)) {
          return yield* Effect.failCause(exit.cause);
        }
        return exit.value;
      }).pipe(Effect.withSpan(getCommandRuntimeSpanName(commandRuntime)));
    });
}

export function withLegacyCommandInstrumentation(): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Analytics | CommandRuntime | Stdio.Stdio | Output | ProcessControl>;
export function withLegacyCommandInstrumentation<Flags extends Record<string, unknown>>(
  options: LegacyCommandInstrumentationOptions<Flags>,
): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Analytics | CommandRuntime | Stdio.Stdio | Output | ProcessControl>;
export function withLegacyCommandInstrumentation<Flags extends Record<string, unknown>>(
  options?: LegacyCommandInstrumentationOptions<Flags>,
) {
  if (options?.analytics === false) {
    return withLegacyCommandTracingImplementation();
  }
  return withLegacyCommandAnalyticsImplementation(options);
}
