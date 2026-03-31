import { Clock, Effect, Exit, Option, Stdio } from "effect";
import { Analytics } from "./analytics.service.ts";
import { withAnalyticsContext } from "./analytics-context.ts";

interface CommandAnalyticsBaseMeta {
  readonly command: string;
}

interface CommandAnalyticsWithFlagsMeta<
  Flags extends Record<string, unknown>,
> extends CommandAnalyticsBaseMeta {
  readonly flags: Flags;
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
  meta: CommandAnalyticsBaseMeta | CommandAnalyticsWithFlagsMeta<Flags>,
): meta is CommandAnalyticsWithFlagsMeta<Flags> {
  return "flags" in meta;
}

function withCommandAnalyticsImplementation<Flags extends Record<string, unknown>>(
  meta: CommandAnalyticsBaseMeta | CommandAnalyticsWithFlagsMeta<Flags>,
) {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const stdio = yield* Stdio.Stdio;
      const args = yield* stdio.args;
      const startedAt = yield* Clock.currentTimeMillis;
      const commandRunId = crypto.randomUUID();
      const flagsUsed = extractFlagsUsed(args);
      const flagValues = hasFlags(meta)
        ? extractAllowedFlagValues(meta.flags, meta.allowedFlagValues ?? [], flagsUsed)
        : {};
      const analyticsContext = {
        command_run_id: commandRunId,
        command: meta.command,
        flags_used: flagsUsed,
        flag_values: flagValues,
      } as const;

      const instrumented = Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          command_run_id: commandRunId,
          command: meta.command,
        });
        return yield* self;
      }).pipe(withAnalyticsContext(analyticsContext));

      const exit = yield* instrumented.pipe(Effect.exit);
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
    });
}

export function withCommandAnalytics(
  meta: CommandAnalyticsBaseMeta,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Analytics | Stdio.Stdio>;
export function withCommandAnalytics<Flags extends Record<string, unknown>>(
  meta: CommandAnalyticsWithFlagsMeta<Flags>,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Analytics | Stdio.Stdio>;
export function withCommandAnalytics<Flags extends Record<string, unknown>>(
  meta: CommandAnalyticsBaseMeta | CommandAnalyticsWithFlagsMeta<Flags>,
) {
  return withCommandAnalyticsImplementation(meta);
}
