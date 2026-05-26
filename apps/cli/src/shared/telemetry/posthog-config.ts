// PostHog connection config shared by both shells' analytics layers.
// Defaults match apps/cli-go/internal/utils/misc.go PostHogAPIKey / PostHogEndpoint
// (set via Go's -ldflags at build time, hard-coded here for the TS build).

const DEFAULT_HOST = "https://eu.i.posthog.com";
const DEFAULT_KEY = "phc_ihjC3EeB2wXCt87yccX5idgIgeZsub7WG0XR5hGFhJz";

export const posthogConfig: {
  readonly host: string;
  readonly key: string;
} = {
  host: process.env.SUPABASE_TELEMETRY_POSTHOG_HOST ?? DEFAULT_HOST,
  key: process.env.SUPABASE_TELEMETRY_POSTHOG_KEY ?? DEFAULT_KEY,
};
