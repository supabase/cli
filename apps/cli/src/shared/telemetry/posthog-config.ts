// PostHog connection config shared by both shells' analytics layers.
// The host is constant (both PostHog projects share the instance). The key is
// injected at build time by apps/cli/scripts/build.ts via
// `bun build --define "process.env.SUPABASE_CLI_POSTHOG_KEY=..."` from the
// POSTHOG_API_KEY release secret; outside a release build it is empty and
// telemetry no-ops.

const DEFAULT_HOST = "https://eu.i.posthog.com";
const DEFAULT_KEY = process.env.SUPABASE_CLI_POSTHOG_KEY ?? "";

export const posthogConfig: {
  readonly host: string;
  readonly key: string;
} = {
  host: process.env.SUPABASE_TELEMETRY_POSTHOG_HOST ?? DEFAULT_HOST,
  key: process.env.SUPABASE_TELEMETRY_POSTHOG_KEY ?? DEFAULT_KEY,
};
