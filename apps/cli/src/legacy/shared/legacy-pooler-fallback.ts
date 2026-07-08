import { Effect, Option } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { legacyYellow } from "./legacy-colors.ts";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";

export function legacyIsDirectDbHost(host: string, projectHost: string): boolean {
  return host.startsWith("db.") && host.endsWith(`.${projectHost}`);
}

/** Mirrors Go's `IsPoolerDbHost` (`internal/utils/connect.go`). */
export function legacyIsPoolerDbHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "pooler.supabase.com" || normalized.endsWith(".pooler.supabase.com");
}

/**
 * Rewrites a linked pooler connection to the direct Supabase database host for
 * pg-delta catalog introspection on an initial migration-style pull. Mirrors Go's
 * `ResolveDirectDbConfigForPgDelta`.
 *
 * This is the inverse of `RunWithPoolerFallback` (direct→pooler when the pg_dump
 * container fails IPv6): here the CLI may have chosen pooler because the host OS
 * cannot dial direct (`NewDbConfigWithPassword`), but pg-delta runs in Docker and
 * often needs `db.<ref>.<host>` to read the full catalog. Only the pg-delta TARGET
 * URL is rewritten; the CLI session keeps using whatever `resolve()` returned.
 */
export function legacyResolveDirectDbConfigForPgDelta(
  conn: LegacyPgConnInput,
  projectRef: string,
  projectHost: string,
): LegacyPgConnInput {
  if (legacyIsDirectDbHost(conn.host, projectHost)) {
    return conn;
  }
  if (!legacyIsPoolerDbHost(conn.host)) {
    // Custom `--db-url` or local targets: leave unchanged.
    return conn;
  }
  // Drop pooler-only tenant routing (`options=reference=…`); direct uses `postgres`.
  const { options: _options, ...rest } = conn;
  return {
    ...rest,
    host: `db.${projectRef}.${projectHost}`,
    port: 5432,
    user: "postgres",
  };
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
