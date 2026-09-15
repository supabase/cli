/** The seven {@link CliConfig} section keys a hosted project-config API response can speak for. */
export const HOSTED_SECTION_KEYS = [
  "api",
  "auth",
  "db",
  "realtime",
  "storage",
  "compute",
  "experimental",
] as const;

/**
 * The seven keys a hosted-section response can speak for. A section whose every field is a
 * {@link DOCUMENT_ONLY_LOCAL_PATHS} member (`realtime` today) is absent from both `ProjectConfig`
 * and its schema, so `HostedSectionKey` is broader than the keys a `ProjectConfig` value can carry.
 */
export type HostedSectionKey = (typeof HOSTED_SECTION_KEYS)[number];

/**
 * Paths inside a hosted section with no real hosted counterpart on either arm, excluded from
 * `ProjectConfig`'s shape, `ProjectConfigSchema`/`toProjectConfigJsonSchema`, and
 * `fromConfigDocument`'s output alike: local bind ports/TLS overrides, `db.pooler`'s
 * `enabled`/`port`, the `db.migrations`/`db.seed` subtrees, every config-side `realtime.*` field,
 * and local-only `experimental.*` engine/backend selection.
 *
 * `db.major_version` and `db.pooler`'s other three fields (`pool_mode`, `default_pool_size`,
 * `max_client_conn`) are real hosted facts and excluded from this list, so `config
 * diff`/`config pull` keep them comparable and can sync them from the platform. `auth.enabled`/
 * `storage.enabled` and `db.network_restrictions.enabled` are also excluded: each is a
 * genuine management opt-out a document can still declare, not a value to hide.
 *
 * Exact-match only; every path below names a static struct field.
 */
export const DOCUMENT_ONLY_LOCAL_PATHS = [
  ["api", "port"],
  ["api", "tls"],
  ["api", "external_url"],
  ["db", "port"],
  ["db", "shadow_port"],
  ["db", "health_timeout"],
  ["db", "pooler", "enabled"],
  ["db", "pooler", "port"],
  ["db", "migrations"],
  ["db", "seed"],
  ["realtime", "enabled"],
  ["realtime", "ip_version"],
  ["realtime", "max_header_length"],
  ["experimental", "stack"],
  ["experimental", "compute"],
  ["experimental", "orioledb_version"],
  ["experimental", "s3_host"],
  ["experimental", "s3_region"],
  ["experimental", "pgdelta"],
  ["experimental", "inspect"],
] as const satisfies ReadonlyArray<ReadonlyArray<string>>;

/** One member tuple of {@link DOCUMENT_ONLY_LOCAL_PATHS}. */
export type DocumentOnlyLocalPath = (typeof DOCUMENT_ONLY_LOCAL_PATHS)[number];

/** Whether `path` exactly matches a {@link DOCUMENT_ONLY_LOCAL_PATHS} member. */
export function isDocumentOnlyLocalPath(path: ReadonlyArray<string>): boolean {
  return DOCUMENT_ONLY_LOCAL_PATHS.some(
    (excluded) =>
      excluded.length === path.length &&
      excluded.every((segment, index) => segment === path[index]),
  );
}
