import { Schema } from "effect";

/**
 * A bundled service. Order in {@link CANONICAL_APPLY_ORDER} mirrors the CLI's
 * `initSchema15` job order (realtime → storage → auth): bundles are generated
 * sequentially by diffing state N−1 → N, so they only compose in that order.
 */
export const ServiceName = Schema.Literals(["realtime", "storage", "auth"]);
export type ServiceName = typeof ServiceName.Type;

export const CANONICAL_APPLY_ORDER: ReadonlyArray<ServiceName> = ["realtime", "storage", "auth"];

/**
 * A `supabase/postgres` image lineage. A bundle is a diff against a specific
 * image lineage (pre-created roles, schemas, the 2017 auth stub), not against
 * empty Postgres, so the lineage is part of the bundle identity.
 */
export const PgLineage = Schema.Literals(["pg15", "pg17"]);
export type PgLineage = typeof PgLineage.Type;

/**
 * How a bundle file must be executed (same naming as pg-delta's migration
 * units). `transactional` files can be wrapped in a single BEGIN/COMMIT;
 * `none` files contain non-transactional units (e.g. `CREATE INDEX
 * CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` followed by use) and must run
 * statement-by-statement outside an explicit transaction.
 */
export const TransactionMode = Schema.Literals(["transactional", "none"]);
export type TransactionMode = typeof TransactionMode.Type;

export const ApplyFile = Schema.Struct({
  /** Path relative to the bundle directory. */
  file: Schema.String,
  transactionMode: TransactionMode,
});
export type ApplyFile = typeof ApplyFile.Type;

/**
 * Everything the artifact is a function of, beyond (service version, pg
 * lineage). v1 pins one canonical tuple: the CLI local-dev configuration.
 * Consumers outside the tuple must fall back to running the service's own
 * migrate job.
 */
export const DeterminismTuple = Schema.Struct({
  /** Exact `supabase/postgres` image the bundle was generated against. */
  postgresImage: Schema.String,
  /**
   * Role the service's migrate job connected as during generation. Recorded
   * for provenance; replay always runs as `supabase_admin` because the plan
   * emits ownership and grants explicitly.
   */
  serviceRole: Schema.String,
  /** Environment passed to the migrate job, verbatim (fixed local-dev keys). */
  env: Schema.Record(Schema.String, Schema.String),
  orioledb: Schema.Literal(false),
});
export type DeterminismTuple = typeof DeterminismTuple.Type;

export const BundleManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  lineage: PgLineage,
  service: ServiceName,
  /** Service release the bundle reproduces, e.g. "v2.124.2". */
  serviceVersion: Schema.String,
  /** Exact service image the migrate job ran from. */
  serviceImage: Schema.String,
  /** Ordered list of SQL files that reproduce the service's database state. */
  apply: Schema.Array(ApplyFile),
  /**
   * Qualified tables whose rows are captured in the data files (migration
   * bookkeeping the service validates at boot, e.g. `storage.migrations`
   * sha1 hashes). Byte-exactness here is what makes the real service no-op
   * when booted against a bundled database.
   */
  trackingTables: Schema.Array(Schema.String),
  /**
   * Object name patterns excluded from the diff because they cannot be
   * static (time-dependent partitions, session-scoped objects). The service
   * recreates them at runtime.
   */
  excluded: Schema.Array(Schema.String),
  tuple: DeterminismTuple,
  /**
   * Service versions applied before this bundle during generation (bundles
   * are diffs of sequential state, so composition is only guaranteed when a
   * consumer's earlier pins match these).
   */
  predecessors: Schema.Record(Schema.String, Schema.String),
  /** Version of @supabase/pg-delta that produced the plan. */
  pgDeltaVersion: Schema.String,
  /** Version of this package's generator. */
  generatorVersion: Schema.String,
});
export type BundleManifest = typeof BundleManifest.Type;

/** Top-level `bundles/manifest.json`: what the tree contains and how to apply it. */
export const RootManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  applyOrder: Schema.Array(ServiceName),
  lineages: Schema.Array(PgLineage),
});
export type RootManifest = typeof RootManifest.Type;

export const decodeBundleManifest = Schema.decodeUnknownEffect(BundleManifest);
export const decodeRootManifest = Schema.decodeUnknownEffect(RootManifest);
