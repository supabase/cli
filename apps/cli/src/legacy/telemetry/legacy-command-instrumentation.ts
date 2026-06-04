import { Clock, Effect, Exit, Option, Stdio } from "effect";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "../../shared/runtime/command-runtime.service.ts";
import { withAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  EventCommandExecuted,
  PropDurationMs,
  PropExitCode,
} from "../../shared/telemetry/event-catalog.ts";

interface LegacyCommandInstrumentationOptions<Flags extends Record<string, unknown> = never> {
  readonly analytics?: boolean;
  readonly flags?: Flags;
  // Flag names (kebab-case) whose values are safe to log verbatim, mirroring
  // Go's `markFlagTelemetrySafe` annotation in cmd/root_analytics.go. Boolean
  // flag values are always passed through, matching Go's isBooleanFlag branch.
  readonly safeFlags?: ReadonlyArray<string>;
}

const REDACTED_VALUE = "<redacted>";

function toCliFlagName(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function extractChangedFlagNames(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const used = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) continue;

    const raw = arg.slice(2);
    const [flagName] = raw.split("=", 2);
    if (flagName === undefined || flagName.length === 0) continue;

    used.add(flagName);
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
        const stdio = yield* Stdio.Stdio;
        const args = yield* stdio.args;
        const startedAt = yield* Clock.currentTimeMillis;
        const changedFlagNames = extractChangedFlagNames(args);
        const flags = buildFlagsMap(options?.flags, safeFlagSet, changedFlagNames);
        const analyticsContext = {
          command_run_id: commandRuntime.commandRunId,
          command,
          flags,
        } as const;

        const exit = yield* self.pipe(withAnalyticsContext(analyticsContext), Effect.exit);
        const finishedAt = yield* Clock.currentTimeMillis;

        yield* analytics
          .capture(EventCommandExecuted, {
            [PropExitCode]: Exit.isSuccess(exit) ? 0 : 1,
            [PropDurationMs]: finishedAt - startedAt,
          })
          .pipe(withAnalyticsContext(analyticsContext));

        if (Exit.isFailure(exit)) {
          return yield* Effect.failCause(exit.cause);
        }
        return exit.value;
      }).pipe(Effect.withSpan(getCommandRuntimeSpanName(commandRuntime)));
    });
}

export function withLegacyCommandInstrumentation(): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Analytics | CommandRuntime | Stdio.Stdio>;
export function withLegacyCommandInstrumentation<Flags extends Record<string, unknown>>(
  options: LegacyCommandInstrumentationOptions<Flags>,
): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Analytics | CommandRuntime | Stdio.Stdio>;
export function withLegacyCommandInstrumentation<Flags extends Record<string, unknown>>(
  options?: LegacyCommandInstrumentationOptions<Flags>,
) {
  if (options?.analytics === false) {
    return withLegacyCommandTracingImplementation();
  }
  return withLegacyCommandAnalyticsImplementation(options);
}
