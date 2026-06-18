import { Context, Data, type Effect } from "effect";

/**
 * A live TLS-capability probe for pg-delta SOURCE/TARGET endpoints, mirroring Go's
 * `isRequireSSL` (`apps/cli-go/internal/gen/types/types.go:150`). Go opens a real
 * connection with `sslmode=require` and treats a `"(server refused TLS connection)"`
 * error as "TLS not required"; any other connection error propagates; a successful
 * connection means "TLS required" (unless `--debug`, which disables SSL).
 *
 * The probe answers only the documented question — *does the server speak TLS?* —
 * which Go performs via a raw Postgres `SSLRequest` negotiation. Certificate
 * validation is intentionally NOT done here (Go's comment: "Cert validation happens
 * downstream in the migra/pgdelta Deno scripts using GetRootCA"); the embedded CA
 * bundle injected by `legacyPreparePgDeltaRef` is what the Deno script verifies
 * against. Splitting this behind a service keeps the network side effect injectable
 * so the pg-delta env-builder stays testable.
 */
export interface LegacyPgDeltaSslProbeShape {
  /**
   * Resolves `true` when the server at `dbUrl` speaks TLS and SSL should be required
   * (Go's `isRequireSSL`). Resolves `false` when the server refuses TLS (Go's
   * "server refused TLS connection") or when `--debug` is set (Go disables SSL in
   * debug mode). Fails for any other connection error, matching Go's `return false, err`.
   */
  readonly requireSsl: (dbUrl: string) => Effect.Effect<boolean, LegacyPgDeltaSslProbeError>;
}

/** A non-TLS-refusal connection failure during the SSL probe (Go's propagated `err`). */
export class LegacyPgDeltaSslProbeError extends Data.TaggedError("LegacyPgDeltaSslProbeError")<{
  readonly message: string;
}> {}

export class LegacyPgDeltaSslProbe extends Context.Service<
  LegacyPgDeltaSslProbe,
  LegacyPgDeltaSslProbeShape
>()("supabase/legacy/PgDeltaSslProbe") {}
