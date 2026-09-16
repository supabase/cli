import { Effect, Option } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { isIPv6ConnectivityError } from "../../../command-internal/connect-errors.ts";
import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import type { DbConnType } from "../../../command-internal/db-target-flags.ts";
import {
  isDirectDbHost,
  runWithPoolerFallback as runWithSharedPoolerFallback,
} from "../../../command-internal/pooler-fallback.ts";

export { emitPoolerFallbackWarning } from "../../../command-internal/pooler-fallback.ts";

/** The exit/stderr pair a dump attempt surfaces for pooler-fallback classification. */
interface PoolerFallbackResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * A dump/diff is only rerouted through the pooler when it's a `--linked` run against a
 * direct Supabase DB host (`db.<ref>.<projectHost>`, never local/pooler); the `!isLocal`
 * check is belt-and-braces since a direct-host match already implies non-local. Shared by
 * the result-based dump/pull retry ({@link runWithPoolerFallback}) and the error-based diff
 * retry in `db pull`, each ANDing in its own IPv6 classification of the relevant error.
 */
export const isDirectLinkedHost = (params: {
  readonly connType: DbConnType;
  readonly host: string;
  readonly isLocal: boolean;
  readonly projectHost: string;
}): boolean =>
  params.connType === "linked" &&
  !params.isLocal &&
  isDirectDbHost(params.host, params.projectHost);

/**
 * Container-level IPv6 → IPv4-pooler retry shared by `db dump` and `db pull`'s initial
 * remote-schema dump. Runs the first attempt's `result` through the host gate and IPv6
 * classification; when eligible and a pooler connection resolves, emits the fallback
 * warning and retries once via `runWithConn`. Otherwise returns the original `result`
 * unchanged, so the caller's failure classification always reads the correct stderr.
 */
export const runWithPoolerFallback = Effect.fnUntraced(function* <E, RRun>(params: {
  /** The first attempt's result; returned unchanged when no fallback fires. */
  readonly result: PoolerFallbackResult;
  readonly connType: DbConnType;
  /** The direct connection host that failed (`resolved.conn.host`). */
  readonly host: string;
  readonly isLocal: boolean;
  /** `cliSettings.projectHost` — the direct-DB-host suffix (`supabase.co`/`.red`). */
  readonly projectHost: string;
  /**
   * Resolves the IPv4 pooler connection, already error-neutralized to `None` (a resolution
   * failure means "no fallback"). A thunk, since resolving the pooler creates a temp role —
   * it only runs once the eligibility gate passes, never on the happy path.
   */
  readonly resolvePooler: () => Effect.Effect<Option.Option<PgConnInput>>;
  /** Re-runs the dump against a connection (`db dump`/`db pull` each adapt their runner). */
  readonly runWithConn: (conn: PgConnInput) => Effect.Effect<PoolerFallbackResult, E, RRun>;
  /** `db dump` re-prints "Dumping ..." on retry; `db pull` passes `Effect.void`. */
  readonly reprintOnRetry: Effect.Effect<void, never, Output>;
}) {
  return yield* runWithSharedPoolerFallback({
    run: Effect.succeed(params.result),
    retry: (pooler) => params.reprintOnRetry.pipe(Effect.andThen(params.runWithConn(pooler))),
    directHost: params.host,
    eligible: isDirectLinkedHost({
      connType: params.connType,
      host: params.host,
      isLocal: params.isLocal,
      projectHost: params.projectHost,
    }),
    resolveFallback: Effect.suspend(params.resolvePooler),
    classifyResult: (result) => result.exitCode !== 0 && isIPv6ConnectivityError(result.stderr),
  });
});
