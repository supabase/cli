import { Context, Data, type Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * A live TLS-capability probe for pg-delta source/target endpoints: opens a raw Postgres
 * `SSLRequest` negotiation to determine whether the server speaks TLS, without completing the
 * handshake or validating certificates — that happens downstream in the migra/pgdelta Deno
 * scripts, using the embedded CA bundle `preparePgDeltaRef` injects. A refused negotiation
 * means SSL isn't required; any other connection error propagates. A service so the network
 * side effect stays injectable for tests.
 */
export interface PgDeltaSslProbeShape {
  /**
   * Resolves `true` when the server at `dbUrl` speaks TLS and SSL should be required.
   * Resolves `false` when the server refuses TLS, or when `--debug` is set. Fails for any
   * other connection error.
   */
  readonly requireSsl: (dbUrl: string) => Effect.Effect<boolean, PgDeltaSslProbeError>;
  readonly requireSslForHost: (
    host: string,
    port: number,
  ) => Effect.Effect<boolean, PgDeltaSslProbeError>;
}

/** A non-TLS-refusal connection failure during the SSL probe. */
export class PgDeltaSslProbeError extends Data.TaggedError("PgDeltaSslProbeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

export class PgDeltaSslProbe extends Context.Service<PgDeltaSslProbe, PgDeltaSslProbeShape>()(
  "supabase/cli/PgDeltaSslProbe",
) {}
