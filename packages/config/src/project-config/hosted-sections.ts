/**
 * The seven {@link CliConfig} (`../base.ts`) section keys a hosted
 * project-config API response can speak for — the vocabulary ceiling for
 * {@link ProjectConfig} (`./project-config.ts`)'s compile-time type and
 * {@link ProjectConfigSchema} (`./project-schema.ts`)'s runtime derivation.
 * Owned here rather than duplicated in either consumer, per this repo's
 * policy of moving a shared constant to its correct owner instead of
 * hand-keeping two copies in sync.
 */
export const HOSTED_SECTION_KEYS = [
  "api",
  "auth",
  "db",
  "realtime",
  "storage",
  "workers",
  "experimental",
] as const;

/** The seven keys {@link ProjectConfig}/{@link ProjectConfigSchema} can carry. */
export type HostedSectionKey = (typeof HOSTED_SECTION_KEYS)[number];
