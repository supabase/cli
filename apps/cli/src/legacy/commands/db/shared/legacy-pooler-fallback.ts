import { Effect, Option } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { legacyIsIPv6ConnectivityError } from "../../../shared/legacy-connect-errors.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import {
  legacyIsDirectDbHost,
  legacyRunWithPoolerFallback as legacyRunWithSharedPoolerFallback,
} from "../../../shared/legacy-pooler-fallback.ts";

export { legacyEmitPoolerFallbackWarning } from "../../../shared/legacy-pooler-fallback.ts";

/** The exit/stderr pair a dump attempt surfaces for pooler-fallback classification. */
interface LegacyPoolerFallbackResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Go's `PoolerFallbackConfig` host gate (`internal/db/dump/pooler_fallback.go:82-96`):
 * a dump/diff is only rerouted through the pooler when it was a `--linked` run against
 * a *direct* Supabase DB host (`db.<ref>.<projectHost>`, never local/pooler).
 * `ProjectRefFromDirectDbHost` already excludes local, and `PoolerFallbackEligible ==
 * linked` makes local impossible — the `!isLocal` check is belt-and-braces. Shared by
 * the result-based dump/pull retry ({@link legacyRunWithPoolerFallback}) and the
 * error-based diff retry in `db pull`; each ANDs in its own IPv6 classification of the
 * relevant stderr/error.
 */
export const legacyIsDirectLinkedHost = (params: {
  readonly connType: LegacyDbConnType;
  readonly host: string;
  readonly isLocal: boolean;
  readonly projectHost: string;
}): boolean =>
  params.connType === "linked" &&
  !params.isLocal &&
  legacyIsDirectDbHost(params.host, params.projectHost);

/**
 * Container-level IPv6 → IPv4-pooler retry shared by `db dump` and `db pull`'s initial
 * remote-schema dump — the single port of Go's `RunWithPoolerFallback`
 * (`internal/db/dump/pooler_fallback.go:31-66`). Runs the first attempt's `result`
 * through the host gate + IPv6 classification; when eligible and a pooler connection
 * resolves, emits Go's warning and retries once via `runWithConn`, returning the
 * retry's result. Otherwise returns the original `result` unchanged, so the caller's
 * failure classification reads the correct stderr in both cases (Go returns the retry
 * error on a failed retry, the original error on no fallback).
 *
 * The one load-bearing per-command difference is `reprintOnRetry`: Go prints the
 * "Dumping ..." line *inside* `db dump`'s run closure, so it re-prints on the retry
 * (`dump.go:39-45`); `db pull` prints it once *before* `RunWithPoolerFallback`
 * (`pull.go:146`), so it does not. Callers pass the re-print effect (`db dump`) or
 * `Effect.void` (`db pull`).
 *
 * Two Go behaviours are intentionally *not* reproduced here (pre-existing TS gaps,
 * unchanged by this hoist): the `resetOutput` truncation between attempts (each caller
 * (re)truncates its own file per attempt / streams to stdout) and the
 * `SuggestIPv6Pooler` URL enrichment on the no-fallback hint (callers fall back to the
 * generic `legacyIpv6Suggestion`).
 */
export const legacyRunWithPoolerFallback = Effect.fnUntraced(function* <E, RRun>(params: {
  /** The first attempt's result; returned unchanged when no fallback fires. */
  readonly result: LegacyPoolerFallbackResult;
  readonly connType: LegacyDbConnType;
  /** The direct connection host that failed (`resolved.conn.host`). */
  readonly host: string;
  readonly isLocal: boolean;
  /** `cliConfig.projectHost` — the direct-DB-host suffix (`supabase.co`/`.red`). */
  readonly projectHost: string;
  /**
   * Resolves the IPv4 pooler connection, already error-neutralised to `None` (the
   * caller pipes `resolver.resolvePoolerFallback(...)` through `orElseSucceed(None)`) —
   * Go treats any fallback-resolution error as "no fallback" and surfaces the original
   * dump failure. A **thunk**: Go only resolves the pooler (creating a temp role) once
   * the error is eligible, so this is invoked only after the gate passes, never on the
   * happy path.
   */
  readonly resolvePooler: () => Effect.Effect<Option.Option<LegacyPgConnInput>>;
  /** Re-runs the dump against a connection (`db dump`/`db pull` each adapt their runner). */
  readonly runWithConn: (
    conn: LegacyPgConnInput,
  ) => Effect.Effect<LegacyPoolerFallbackResult, E, RRun>;
  /** `db dump` re-prints "Dumping ..." on retry; `db pull` passes `Effect.void`. */
  readonly reprintOnRetry: Effect.Effect<void, never, Output>;
}) {
  return yield* legacyRunWithSharedPoolerFallback({
    run: Effect.succeed(params.result),
    retry: (pooler) => params.reprintOnRetry.pipe(Effect.andThen(params.runWithConn(pooler))),
    directHost: params.host,
    eligible: legacyIsDirectLinkedHost({
      connType: params.connType,
      host: params.host,
      isLocal: params.isLocal,
      projectHost: params.projectHost,
    }),
    resolveFallback: Effect.suspend(params.resolvePooler),
    classifyResult: (result) =>
      result.exitCode !== 0 && legacyIsIPv6ConnectivityError(result.stderr),
  });
});
