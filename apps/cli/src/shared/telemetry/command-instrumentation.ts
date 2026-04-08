import { Clock, Effect, Exit, Option, Stdio } from "effect";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
  getCommandRuntimeSpanName,
} from "../runtime/command-runtime.service.ts";
import { withAnalyticsContext } from "./analytics-context.ts";
import { Analytics } from "./analytics.service.ts";

interface CommandInstrumentationOptions<Flags extends Record<string, unknown> = never> {
  readonly analytics?: boolean;
  readonly flags?: Flags;
  readonly allowedFlagValues?: ReadonlyArray<Extract<keyof Flags, string>>;
}

function toCliFlagName(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function extractFlagsUsed(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const used = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) continue;

    const raw = arg.slice(2);
    const [flagName] = raw.split("=", 2);
    if (flagName === undefined || flagName.length === 0) continue;

    used.add(flagName);
  }

  return [...used].sort((left, right) => left.localeCompare(right));
}

function normalizeFlagValue(value: unknown): unknown | undefined {
  if (value === undefined) return undefined;
  if (!Option.isOption(value)) return value;
  if (Option.isNone(value)) return undefined;
  return normalizeFlagValue(value.value);
}

function extractAllowedFlagValues<Flags extends Record<string, unknown>>(
  flags: Flags,
  allowedFlagValues: ReadonlyArray<Extract<keyof Flags, string>>,
  flagsUsed: ReadonlyArray<string>,
): Record<string, unknown> {
  const usedFlagSet = new Set(flagsUsed);
  const entries: Array<readonly [string, unknown]> = [];

  for (const key of allowedFlagValues) {
    const flagName = toCliFlagName(key);
    if (!usedFlagSet.has(flagName)) continue;

    const value = normalizeFlagValue(flags[key]);
    if (value === undefined) continue;

    entries.push([flagName, value]);
  }

  return Object.fromEntries(entries);
}

function hasFlags<Flags extends Record<string, unknown>>(
  options: CommandInstrumentationOptions<Flags> | undefined,
): options is CommandInstrumentationOptions<Flags> & { readonly flags: Flags } {
  return options?.flags !== undefined;
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
  options?: CommandInstrumentationOptions<Flags>,
) {
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
        const flagsUsed = extractFlagsUsed(args);
        const flagValues = hasFlags(options)
          ? extractAllowedFlagValues(options.flags, options.allowedFlagValues ?? [], flagsUsed)
          : {};
        const analyticsContext = {
          command_run_id: commandRuntime.commandRunId,
          command,
          flags_used: flagsUsed,
          flag_values: flagValues,
        } as const;

        const exit = yield* self.pipe(withAnalyticsContext(analyticsContext), Effect.exit);
        const finishedAt = yield* Clock.currentTimeMillis;

        yield* analytics
          .capture("cli_command_executed", {
            exit_code: Exit.isSuccess(exit) ? 0 : 1,
            duration_ms: finishedAt - startedAt,
          })
          .pipe(withAnalyticsContext(analyticsContext));

        if (Exit.isFailure(exit)) {
          return yield* Effect.failCause(exit.cause);
        }
        return exit.value;
      }).pipe(Effect.withSpan(getCommandRuntimeSpanName(commandRuntime)));
    });
}

export function withCommandInstrumentation(): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Analytics | CommandRuntime | Stdio.Stdio>;
export function withCommandInstrumentation<Flags extends Record<string, unknown>>(
  options: CommandInstrumentationOptions<Flags>,
): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Analytics | CommandRuntime | Stdio.Stdio>;
export function withCommandInstrumentation<Flags extends Record<string, unknown>>(
  options?: CommandInstrumentationOptions<Flags>,
) {
  if (options?.analytics === false) {
    return withCommandTracingImplementation();
  }
  return withCommandAnalyticsImplementation(options);
}
