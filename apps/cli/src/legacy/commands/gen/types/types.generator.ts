import { Context, type Effect } from "effect";

import type { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyPgDeltaSslProbeError } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import type { LegacyGenTypesGenerateError, LegacyGenTypesMetadataError } from "./types.errors.ts";

export type LegacyGenTypesLang = "typescript" | "go" | "swift" | "python";

export interface LegacyGenTypesGenerateInput {
  /** The database to introspect. */
  readonly conn: LegacyPgConnInput;
  /** Whether `conn` targets the local stack (drives the driver's TLS mode). */
  readonly isLocal: boolean;
  /** The active `--dns-resolver` value, forwarded to the driver layer. */
  readonly dnsResolver: "native" | "https";
  readonly lang: LegacyGenTypesLang;
  /** Schemas to include; empty means the introspector's own default set. */
  readonly includedSchemas: ReadonlyArray<string>;
  /**
   * `--postgrest-v9-compat`: disables one-to-one relationship detection in the
   * TypeScript generator (ignored by the other languages), matching the
   * `PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=!v9compat` env the
   * retired pg-meta container path received.
   */
  readonly postgrestV9Compat: boolean;
  /** `--swift-access-control` (Swift generator only). */
  readonly swiftAccessControl: "internal" | "public";
  /**
   * `--query-timeout` in whole seconds. Applied as session `statement_timeout`,
   * a client-side bound around `introspect()`, and — when the DSN has no
   * `connect_timeout` and this value is positive — the connect timeout.
   * `0` disables the query bounds and leaves the driver's connect default.
   */
  readonly queryTimeoutSeconds: number;
}

interface LegacyGenTypesGeneratorShape {
  /**
   * Connect to `conn`, introspect it with `@supabase/postgrest-typegen`, and
   * render the generated types for `lang`. The returned string is the exact
   * generator output (no trailing newline added).
   */
  readonly generate: (
    input: LegacyGenTypesGenerateInput,
  ) => Effect.Effect<
    string,
    | LegacyDbConnectError
    | LegacyGenTypesGenerateError
    | LegacyGenTypesMetadataError
    | LegacyPgDeltaSslProbeError
  >;
}

/**
 * Native type generation for `gen types`, backed by
 * `@supabase/postgrest-typegen` over a real Postgres connection. A service so
 * handler integration tests can replace the live database + generator with a
 * recording fake.
 */
export class LegacyGenTypesGenerator extends Context.Service<
  LegacyGenTypesGenerator,
  LegacyGenTypesGeneratorShape
>()("supabase/legacy/GenTypesGenerator") {}
