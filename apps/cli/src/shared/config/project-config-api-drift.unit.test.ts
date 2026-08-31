import { describe, expect, it } from "vitest";
import { V2GetProjectConfigOutput } from "@supabase/api/effect";
import { toProjectConfig, type ProjectConfigApiAttributes } from "@supabase/config";

/**
 * Compile-time drift guards (CLI-2230 design requirement): `@supabase/config`
 * deliberately hand-mirrors the Management API v2 project-config response
 * shape in `ProjectConfigApiAttributes` rather than importing
 * `packages/api`'s generated client (the config package must stay decoupled
 * from `@supabase/api` so it can publish to npm independently). That mirror
 * can only ever drift silently from the real, generated OpenAPI contract —
 * unless something pins the two together. Two independent checks do that,
 * because neither alone covers every kind of drift:
 *
 * 1. `_typeDriftGuard` below fails to compile if the real contract *widens* a
 *    field's type out from under the lenient mirror (e.g. a field changing
 *    from a primitive to an object). It does NOT catch a field the real
 *    contract adds, removes, or renames: TypeScript's structural
 *    assignability allows the source type (the real contract's attributes)
 *    to carry extra or differently-named properties the target type (the
 *    mirror) never sees, so the assignment still compiles.
 * 2. The type-level key-set assertions further down this file
 *    (`AssertNever<Exclude<keyof A, keyof B>>`, one added/removed pair per
 *    mirrored nesting level) are the guard for exactly that gap: an added,
 *    removed, or renamed key at any mirrored level fails one of those
 *    assertions to compile. `auth` is exempt — both sides model it as an
 *    open `Record<string, Json>`, so there is no fixed key set to diff.
 *
 * `_typeDriftGuard` is also intentionally vacuous for every field
 * `ProjectConfigApiAttributes` mirrors as `Schema.Unknown` (every unmapped
 * field, per `api-attributes.ts`'s own docstring): the mirror's field type is
 * `unknown`, and every type is assignable to `unknown`, so a real-contract
 * type change on one of those fields can never fail this assignability check
 * — only the key-set assertions in point 2 still catch that field being
 * added, removed, or renamed outright. This is by design (ADR 0019 rule 2:
 * an unmapped field's *type* is deliberately not load-bearing at decode
 * time), not a gap this file needs to close.
 *
 * No `as` cast anywhere in this file: a cast would defeat either guard's
 * entire purpose by silencing exactly the failure it exists to surface.
 */
const _typeDriftGuard: (
  value: (typeof V2GetProjectConfigOutput.Type)["data"]["attributes"],
) => ProjectConfigApiAttributes = (value) => value;

type AssertNever<T extends never> = T;

type GeneratedAttrs = (typeof V2GetProjectConfigOutput.Type)["data"]["attributes"];

type _AddedTopLevelKeys = AssertNever<
  Exclude<keyof GeneratedAttrs, keyof ProjectConfigApiAttributes>
>;
type _RemovedTopLevelKeys = AssertNever<
  Exclude<keyof ProjectConfigApiAttributes, keyof GeneratedAttrs>
>;

type GeneratedDatabase = NonNullable<GeneratedAttrs["database"]>;
type MirrorDatabase = NonNullable<ProjectConfigApiAttributes["database"]>;

type _AddedDatabaseKeys = AssertNever<Exclude<keyof GeneratedDatabase, keyof MirrorDatabase>>;
type _RemovedDatabaseKeys = AssertNever<Exclude<keyof MirrorDatabase, keyof GeneratedDatabase>>;

type GeneratedPostgresSettings = NonNullable<GeneratedDatabase["postgres_settings"]>;
type MirrorPostgresSettings = NonNullable<MirrorDatabase["postgres_settings"]>;

type _AddedPostgresSettingsKeys = AssertNever<
  Exclude<keyof GeneratedPostgresSettings, keyof MirrorPostgresSettings>
>;
type _RemovedPostgresSettingsKeys = AssertNever<
  Exclude<keyof MirrorPostgresSettings, keyof GeneratedPostgresSettings>
>;

type GeneratedNetworkRestrictions = NonNullable<GeneratedDatabase["network_restrictions"]>;
type MirrorNetworkRestrictions = NonNullable<MirrorDatabase["network_restrictions"]>;

type _AddedNetworkRestrictionsKeys = AssertNever<
  Exclude<keyof GeneratedNetworkRestrictions, keyof MirrorNetworkRestrictions>
>;
type _RemovedNetworkRestrictionsKeys = AssertNever<
  Exclude<keyof MirrorNetworkRestrictions, keyof GeneratedNetworkRestrictions>
>;

// `allowed_cidrs` is mapped (`filterCidrAddresses`, `@supabase/config`'s
// `registry.ts`), so its element shape stays concretely typed on the mirror
// side (unlike the sibling `entitlement`/`status`/`updated_at`/`applied_at`
// fields above, which the mirror widens to `Schema.Unknown` since no row
// maps them) — worth its own key-set pair.
type GeneratedAllowedCidrsElement = NonNullable<
  GeneratedNetworkRestrictions["allowed_cidrs"]
>[number];
type MirrorAllowedCidrsElement = NonNullable<MirrorNetworkRestrictions["allowed_cidrs"]>[number];

type _AddedAllowedCidrsElementKeys = AssertNever<
  Exclude<keyof GeneratedAllowedCidrsElement, keyof MirrorAllowedCidrsElement>
>;
type _RemovedAllowedCidrsElementKeys = AssertNever<
  Exclude<keyof MirrorAllowedCidrsElement, keyof GeneratedAllowedCidrsElement>
>;

type GeneratedPooler = NonNullable<GeneratedAttrs["pooler"]>;
type MirrorPooler = NonNullable<ProjectConfigApiAttributes["pooler"]>;

type _AddedPoolerKeys = AssertNever<Exclude<keyof GeneratedPooler, keyof MirrorPooler>>;
type _RemovedPoolerKeys = AssertNever<Exclude<keyof MirrorPooler, keyof GeneratedPooler>>;

type GeneratedApi = NonNullable<GeneratedAttrs["api"]>;
type MirrorApi = NonNullable<ProjectConfigApiAttributes["api"]>;

type _AddedApiKeys = AssertNever<Exclude<keyof GeneratedApi, keyof MirrorApi>>;
type _RemovedApiKeys = AssertNever<Exclude<keyof MirrorApi, keyof GeneratedApi>>;

type GeneratedRealtime = NonNullable<GeneratedAttrs["realtime"]>;
type MirrorRealtime = NonNullable<ProjectConfigApiAttributes["realtime"]>;

type _AddedRealtimeKeys = AssertNever<Exclude<keyof GeneratedRealtime, keyof MirrorRealtime>>;
type _RemovedRealtimeKeys = AssertNever<Exclude<keyof MirrorRealtime, keyof GeneratedRealtime>>;

type GeneratedStorage = NonNullable<GeneratedAttrs["storage"]>;
type MirrorStorage = NonNullable<ProjectConfigApiAttributes["storage"]>;

type _AddedStorageKeys = AssertNever<Exclude<keyof GeneratedStorage, keyof MirrorStorage>>;
type _RemovedStorageKeys = AssertNever<Exclude<keyof MirrorStorage, keyof GeneratedStorage>>;

type GeneratedStorageFeatures = NonNullable<GeneratedStorage["features"]>;
type MirrorStorageFeatures = NonNullable<MirrorStorage["features"]>;

type _AddedStorageFeaturesKeys = AssertNever<
  Exclude<keyof GeneratedStorageFeatures, keyof MirrorStorageFeatures>
>;
type _RemovedStorageFeaturesKeys = AssertNever<
  Exclude<keyof MirrorStorageFeatures, keyof GeneratedStorageFeatures>
>;

// `image_transformation`/`s3_protocol` are mapped (`@supabase/config`'s
// `registry.ts`), so — unlike sibling `purge_cache`, which the mirror widens
// to `Schema.Unknown` since no row maps it — they stay concretely typed
// `{enabled}` structs on the mirror side, each worth its own key-set pair.
type GeneratedImageTransformation = NonNullable<GeneratedStorageFeatures["image_transformation"]>;
type MirrorImageTransformation = NonNullable<MirrorStorageFeatures["image_transformation"]>;

type _AddedImageTransformationKeys = AssertNever<
  Exclude<keyof GeneratedImageTransformation, keyof MirrorImageTransformation>
>;
type _RemovedImageTransformationKeys = AssertNever<
  Exclude<keyof MirrorImageTransformation, keyof GeneratedImageTransformation>
>;

type GeneratedS3Protocol = NonNullable<GeneratedStorageFeatures["s3_protocol"]>;
type MirrorS3Protocol = NonNullable<MirrorStorageFeatures["s3_protocol"]>;

type _AddedS3ProtocolKeys = AssertNever<Exclude<keyof GeneratedS3Protocol, keyof MirrorS3Protocol>>;
type _RemovedS3ProtocolKeys = AssertNever<
  Exclude<keyof MirrorS3Protocol, keyof GeneratedS3Protocol>
>;

type GeneratedIcebergCatalog = NonNullable<GeneratedStorageFeatures["iceberg_catalog"]>;
type MirrorIcebergCatalog = NonNullable<MirrorStorageFeatures["iceberg_catalog"]>;

type _AddedIcebergCatalogKeys = AssertNever<
  Exclude<keyof GeneratedIcebergCatalog, keyof MirrorIcebergCatalog>
>;
type _RemovedIcebergCatalogKeys = AssertNever<
  Exclude<keyof MirrorIcebergCatalog, keyof GeneratedIcebergCatalog>
>;

type GeneratedVectorBuckets = NonNullable<GeneratedStorageFeatures["vector_buckets"]>;
type MirrorVectorBuckets = NonNullable<MirrorStorageFeatures["vector_buckets"]>;

type _AddedVectorBucketsKeys = AssertNever<
  Exclude<keyof GeneratedVectorBuckets, keyof MirrorVectorBuckets>
>;
type _RemovedVectorBucketsKeys = AssertNever<
  Exclude<keyof MirrorVectorBuckets, keyof GeneratedVectorBuckets>
>;

// `storage.capabilities` is unmapped in full (no row reads `list_v2` or
// `iceberg_catalog`), so the mirror widens the whole substruct to
// `Schema.Unknown` (`@supabase/config`'s `api-attributes.ts`) rather than
// keeping a `{list_v2, iceberg_catalog}` shape — there is no longer an inner
// key set to diff here. `_AddedStorageKeys`/`_RemovedStorageKeys` above still
// cover `capabilities`'s own presence as a key of `storage`; only its
// interior stopped being type-checked, which is the point of widening an
// unmapped field.

describe("project-config API type drift guard", () => {
  it("keeps the generated v2 attributes type assignable to the package's lenient input type", () => {
    // The type-level assignment above (and the type-level key-set assertions
    // further up this file) are the real guards; this only asserts the guard
    // function itself is a callable identity so the module isn't pure dead
    // code under `noUnusedLocals`-style lint passes.
    expect(typeof _typeDriftGuard).toBe("function");
  });

  it("maps a real-shaped v2 envelope through @supabase/config's toProjectConfig", () => {
    const envelope = {
      data: {
        type: "project_config",
        id: "abcdefghijklmnopqrst",
        attributes: {
          api: {
            db_schema: "public,graphql_public",
            db_extra_search_path: "public,extensions",
            max_rows: 500,
            db_pool_acquisition_timeout: 10,
            db_pool: null,
          },
          database: {
            major_version: 17,
            ssl_enforced: true,
            network_restrictions: {
              entitlement: "allowed",
              status: "applied",
              allowed_cidrs: [],
              updated_at: "2026-01-01T00:00:00Z",
              applied_at: "2026-01-01T00:00:00Z",
            },
            postgres_settings: {},
          },
          pooler: {
            pool_mode: "transaction",
            ignore_startup_parameters: "",
            server_idle_timeout: 600,
            server_lifetime: 3600,
            query_wait_timeout: 120,
            reserve_pool_size: 0,
            default_pool_size: 15,
            max_client_conn: 200,
          },
          auth: {
            disable_signup: false,
            external_github_enabled: true,
          },
          realtime: {
            private_only: false,
            max_concurrent_users: 200,
            max_events_per_second: 100,
            max_bytes_per_second: 100000,
            max_channels_per_client: 100,
            max_joins_per_second: 100,
            max_presence_events_per_second: 100,
            max_payload_size_in_kb: 3000,
            presence_enabled: true,
            suspend: false,
            connection_pool: 5,
            postgres_changes_pool: null,
          },
          storage: {
            file_size_limit: 52428800,
            features: {
              image_transformation: { enabled: true },
              s3_protocol: { enabled: false },
              purge_cache: { enabled: false },
              iceberg_catalog: {
                enabled: false,
                max_namespaces: 0,
                max_tables: 0,
                max_catalogs: 0,
              },
              vector_buckets: { enabled: false, max_buckets: 0, max_indexes: 0 },
            },
            capabilities: { list_v2: true, iceberg_catalog: false },
            upstream_target: "main",
            migration_version: "v1",
            database_pool_mode: "transaction",
          },
        },
      },
    };

    const result = toProjectConfig({ apiResponse: envelope });

    expect(result.api).toEqual({
      schemas: ["public", "graphql_public"],
      enabled: true,
      extra_search_path: ["public", "extensions"],
      max_rows: 500,
    });
    expect(result.db?.major_version).toBe(17);
    expect(result.storage?.file_size_limit).toBe("50MiB");
    expect(result.auth?.external?.github).toEqual({ enabled: true });
  });
});
