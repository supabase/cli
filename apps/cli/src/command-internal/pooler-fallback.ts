import { Effect, Option } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { yellow } from "./colors.ts";
import type { PgConnInput } from "./db-connection.service.ts";

export function isDirectDbHost(host: string, projectHost: string): boolean {
  return host.startsWith("db.") && host.endsWith(`.${projectHost}`);
}

export interface PoolerFallbackOptions<A, E, R, R2, RF> {
  readonly run: Effect.Effect<A, E, R>;
  readonly retry: (pooler: PgConnInput) => Effect.Effect<A, E, R2>;
  readonly directHost: string;
  readonly eligible: boolean;
  readonly resolveFallback: Effect.Effect<Option.Option<PgConnInput>, unknown, RF>;
  readonly classifyError?: (error: E) => boolean;
  readonly classifyResult?: (result: A) => boolean;
}

/** The established IPv6 pooler-fallback warning, yellow on stderr, emitted before the IPv4 retry. */
export const emitPoolerFallbackWarning = (host: string): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw(
      `${yellow(
        `Warning: Direct connection to ${host} is unavailable because this environment does not support IPv6.\nRetrying via the IPv4 connection pooler.`,
      )}\n`,
      "stderr",
    );
  });

export function runWithPoolerFallback<A, E, R, R2, RF>(
  options: PoolerFallbackOptions<A, E, R, R2, RF>,
): Effect.Effect<A, E, R | R2 | RF | Output> {
  const resolveFallback = options.resolveFallback.pipe(
    Effect.orElseSucceed(() => Option.none<PgConnInput>()),
  );

  const retryOrReturn = (result: A) =>
    Effect.gen(function* () {
      const pooler = yield* resolveFallback;
      if (Option.isNone(pooler)) return result;
      yield* emitPoolerFallbackWarning(options.directHost);
      return yield* options.retry(pooler.value);
    });

  const retryOrFail = (error: E) =>
    Effect.gen(function* () {
      const pooler = yield* resolveFallback;
      if (Option.isNone(pooler)) return yield* Effect.fail(error);
      yield* emitPoolerFallbackWarning(options.directHost);
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
