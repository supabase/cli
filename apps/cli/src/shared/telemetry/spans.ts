import { Clock, Context, Effect, Exit } from "effect";
import type { Scope, Tracer } from "effect";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import { makeHandle, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

/** Whether spawned processes receive `TRACEPARENT`; true only while a trace sink is active. */
export const ChildTracePropagation = Context.Reference<boolean>(
  "supabase/telemetry/ChildTracePropagation",
  { defaultValue: () => false },
);

/** What a process span records about the child: never argv or environment values. */
export interface ProcessSpanTarget {
  readonly executable: string;
  readonly argCount: number;
  /** A fixed-vocabulary verb such as `container inspect`; never free-form argv. */
  readonly subcommand?: string;
  /**
   * Marks an attempt that has a fallback: a failure is recorded as `process.attempt_failed`
   * instead of failing the span.
   */
  readonly hasFallback?: boolean;
}

/** Extra environment for a child process; empty unless a trace sink is active. */
export type ChildTraceEnv = Readonly<Record<string, string>>;

const noTraceEnv: ChildTraceEnv = {};

function basename(executable: string): string {
  const segments = executable.split(/[\\/]/u);
  return segments[segments.length - 1] ?? executable;
}

const processAttributes = (target: ProcessSpanTarget) => ({
  "process.executable.name": basename(target.executable),
  "process.arg_count": target.argCount,
  ...(target.subcommand === undefined ? {} : { "process.subcommand": target.subcommand }),
});

const traceEnvFor = Effect.fnUntraced(function* (span: Tracer.Span) {
  const enabled = yield* ChildTracePropagation;
  return enabled
    ? { TRACEPARENT: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}` }
    : noTraceEnv;
});

/** Merges `traceEnv` into spawn options without dropping the inherited environment. */
export function withChildTraceEnv(
  options: ChildProcess.CommandOptions | undefined,
  traceEnv: ChildTraceEnv,
): ChildProcess.CommandOptions | undefined {
  if (Object.keys(traceEnv).length === 0) return options;
  if (options?.env === undefined) return { ...options, env: traceEnv, extendEnv: true };
  return { ...options, env: { ...options.env, ...traceEnv } };
}

/**
 * Runs a child process to completion inside a span and records its exit code when `exitCode`
 * extracts one from the result.
 */
export const withProcessSpan = <A, E, R>(
  name: string,
  target: ProcessSpanTarget,
  run: (traceEnv: ChildTraceEnv) => Effect.Effect<A, E, R>,
  exitCode: (result: A) => number | undefined = (result) =>
    typeof result === "number" ? result : undefined,
): Effect.Effect<A, E, R> => {
  const options = { attributes: processAttributes(target) };
  const traced = (span: Tracer.Span) =>
    traceEnvFor(span).pipe(
      Effect.flatMap((traceEnv) =>
        run(traceEnv).pipe(Effect.withParentSpan(span, { captureStackTrace: false })),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          const code = exitCode(result);
          if (code !== undefined) span.attribute("process.exit_code", code);
        }),
      ),
    );
  if (target.hasFallback !== true) return Effect.useSpan(name, options, traced);
  return Effect.useSpan(name, options, (span) =>
    traced(span).pipe(
      Effect.tapCause(() => Effect.sync(() => span.attribute("process.attempt_failed", true))),
      Effect.exit,
    ),
  ).pipe(Effect.flatten);
};

/**
 * Spawns a child process whose span stays open until the surrounding scope closes and records
 * the exit code once the caller awaits it. A failed spawn ends the span immediately.
 */
export const withProcessSpanScoped = <E, R>(
  name: string,
  target: ProcessSpanTarget,
  spawn: (traceEnv: ChildTraceEnv) => Effect.Effect<ChildProcessHandle, E, R>,
): Effect.Effect<ChildProcessHandle, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    const span = yield* Effect.makeSpan(name, { attributes: processAttributes(target) });
    const endSpan = (exit: Exit.Exit<unknown, unknown>) =>
      Effect.map(Clock.currentTimeNanos, (now) => span.end(now, exit));
    const traceEnv = yield* traceEnvFor(span);
    const spawned = yield* spawn(traceEnv).pipe(
      Effect.withParentSpan(span, { captureStackTrace: false }),
      Effect.exit,
    );
    if (Exit.isFailure(spawned)) {
      if (target.hasFallback === true) span.attribute("process.attempt_failed", true);
      yield* endSpan(target.hasFallback === true ? Exit.void : spawned);
      return yield* spawned;
    }
    yield* Effect.addFinalizer(endSpan);
    const handle = spawned.value;
    return makeHandle({
      ...handle,
      exitCode: handle.exitCode.pipe(
        Effect.tap((code) => Effect.sync(() => span.attribute("process.exit_code", code))),
      ),
    });
  });
