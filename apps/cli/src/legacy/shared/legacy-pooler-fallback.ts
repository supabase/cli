import { Effect, Option } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { legacyYellow } from "./legacy-colors.ts";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";

export function legacyIsDirectDbHost(host: string, projectHost: string): boolean {
  return host.startsWith("db.") && host.endsWith(`.${projectHost}`);
}

export interface LegacyPoolerFallbackOptions<A, E, R, R2, RF> {
  readonly run: Effect.Effect<A, E, R>;
  readonly retry: (pooler: LegacyPgConnInput) => Effect.Effect<A, E, R2>;
  readonly directHost: string;
  readonly eligible: boolean;
  readonly resolveFallback: Effect.Effect<Option.Option<LegacyPgConnInput>, unknown, RF>;
  readonly classifyError?: (error: E) => boolean;
  readonly classifyResult?: (result: A) => boolean;
}

/**
 * Go's IPv6 pooler-fallback warning (`internal/utils/connect.go:283-289`), to stderr,
 * `Yellow`-wrapped, byte-for-byte. Emitted just before the IPv4 pooler retry.
 */
export const legacyEmitPoolerFallbackWarning = (host: string): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw(
      `${legacyYellow(
        `Warning: Direct connection to ${host} is unavailable because this environment does not support IPv6.\nRetrying via the IPv4 connection pooler.`,
      )}\n`,
      "stderr",
    );
  });

export function legacyRunWithPoolerFallback<A, E, R, R2, RF>(
  options: LegacyPoolerFallbackOptions<A, E, R, R2, RF>,
): Effect.Effect<A, E, R | R2 | RF | Output> {
  const resolveFallback = options.resolveFallback.pipe(
    Effect.orElseSucceed(() => Option.none<LegacyPgConnInput>()),
  );

  const retryOrReturn = (result: A) =>
    Effect.gen(function* () {
      const pooler = yield* resolveFallback;
      if (Option.isNone(pooler)) return result;
      yield* legacyEmitPoolerFallbackWarning(options.directHost);
      return yield* options.retry(pooler.value);
    });

  const retryOrFail = (error: E) =>
    Effect.gen(function* () {
      const pooler = yield* resolveFallback;
      if (Option.isNone(pooler)) return yield* Effect.fail(error);
      yield* legacyEmitPoolerFallbackWarning(options.directHost);
      return yield* options.retry(pooler.value);
    });

  const shouldRetryResult = (result: A): boolean =>
    options.eligible && (options.classifyResult?.(result) ?? false);
  const shouldRetryError = (error: E): boolean =>
    options.eligible && (options.classifyError?.(error) ?? false);

  return options.run.pipe(
    Effect.matchEffect({
      onFailure: (error) => (shouldRetryError(error) ? retryOrFail(error) : Effect.fail(error)),
      onSuccess: (result) =>
        shouldRetryResult(result) ? retryOrReturn(result) : Effect.succeed(result),
    }),
  );
}
