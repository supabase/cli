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

/** The seven keys {@link ProjectConfig}/{@link ProjectConfigSchema} can carry. */
export type HostedSectionKey = (typeof HOSTED_SECTION_KEYS)[number];
