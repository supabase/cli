export type ServiceName =
  | "postgres"
  | "postgrest"
  | "auth"
  | "realtime"
  | "storage"
  | "imgproxy"
  | "mailpit"
  | "pgmeta"
  | "studio"
  | "analytics"
  | "vector"
  | "pooler";

export interface VersionManifest {
  readonly postgres: string;
  readonly postgrest: string;
  readonly auth: string;
  readonly realtime: string;
  readonly storage: string;
  readonly imgproxy: string;
  readonly mailpit: string;
  readonly pgmeta: string;
  readonly studio: string;
  readonly analytics: string;
  readonly vector: string;
  readonly pooler: string;
}

export const DEFAULT_VERSIONS: VersionManifest = {
  postgres: "17.6.1.081",
  postgrest: "14.5",
  auth: "2.188.0-rc.15",
  realtime: "2.78.10",
  storage: "1.41.8",
  imgproxy: "v3.8.0",
  mailpit: "v1.22.3",
  pgmeta: "0.96.1",
  studio: "2026.03.04-sha-0043607",
  analytics: "1.34.7",
  vector: "0.28.1-alpine",
  pooler: "2.7.4",
} as const;

/** Default registry. Matches the Go CLI default (`public.ecr.aws`). */
const DEFAULT_REGISTRY = "public.ecr.aws/supabase";

const IMAGE_REPOSITORIES: Record<ServiceName, string> = {
  postgres: `${DEFAULT_REGISTRY}/postgres`,
  postgrest: `${DEFAULT_REGISTRY}/postgrest`,
  auth: `${DEFAULT_REGISTRY}/gotrue`,
  realtime: `${DEFAULT_REGISTRY}/realtime`,
  storage: `${DEFAULT_REGISTRY}/storage-api`,
  imgproxy: "darthsim/imgproxy",
  mailpit: "axllent/mailpit",
  pgmeta: `${DEFAULT_REGISTRY}/postgres-meta`,
  studio: `${DEFAULT_REGISTRY}/studio`,
  analytics: `${DEFAULT_REGISTRY}/logflare`,
  vector: "timberio/vector",
  pooler: `${DEFAULT_REGISTRY}/supavisor`,
};

const IMAGE_TAG_PREFIX: Partial<Record<ServiceName, string>> = {
  postgrest: "v",
  auth: "v",
  realtime: "v",
  storage: "v",
  pgmeta: "v",
};

/**
 * Returns the full Docker image URL for a service.
 *
 * Uses the same registry resolution as the Go CLI: images are pulled from
 * `public.ecr.aws/supabase/` by default (faster than Docker Hub).
 */
export function dockerImageForService(service: ServiceName, version: string): string {
  return `${IMAGE_REPOSITORIES[service]}:${IMAGE_TAG_PREFIX[service] ?? ""}${version}`;
}
