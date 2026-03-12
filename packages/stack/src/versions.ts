export type ServiceName = "postgres" | "postgrest" | "auth";

export interface VersionManifest {
  readonly postgres: string;
  readonly postgrest: string;
  readonly auth: string;
}

export const DEFAULT_VERSIONS: VersionManifest = {
  postgres: "17.6.1.081",
  postgrest: "14.5",
  auth: "2.188.0-rc.15",
} as const;

/** Default registry. Matches the Go CLI default (`public.ecr.aws`). */
const DEFAULT_REGISTRY = "public.ecr.aws/supabase";

/**
 * Returns the full Docker image URL for a service.
 *
 * Uses the same registry resolution as the Go CLI: images are pulled from
 * `public.ecr.aws/supabase/` by default (faster than Docker Hub).
 */
export function dockerImageForService(service: ServiceName, version: string): string {
  switch (service) {
    case "postgres":
      return `${DEFAULT_REGISTRY}/postgres:${version}`;
    case "postgrest":
      return `${DEFAULT_REGISTRY}/postgrest:v${version}`;
    case "auth":
      return `${DEFAULT_REGISTRY}/gotrue:v${version}`;
  }
}
