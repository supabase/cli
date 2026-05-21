import type { Option, Redacted } from "effect";
import { Context } from "effect";

/**
 * Built-in profile names with hard-coded API URLs (matches Go's `allProfiles`).
 *
 * `LegacyCliConfig.profile` is typed as `string` (not this union) because Go also
 * supports YAML profile files where `name:` is arbitrary user input. See
 * `legacy-cli-config.layer.ts` for the resolution semantics.
 */
export type LegacyProfileName = "supabase" | "supabase-staging" | "supabase-local";

interface LegacyCliConfigShape {
  readonly profile: string;
  readonly apiUrl: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly projectId: Option.Option<string>;
  readonly workdir: string;
  readonly userAgent: string;
}

export class LegacyCliConfig extends Context.Service<LegacyCliConfig, LegacyCliConfigShape>()(
  "supabase/legacy/CliConfig",
) {}
