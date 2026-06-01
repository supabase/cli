import type { Option, Redacted } from "effect";
import { Context } from "effect";

/**
 * Built-in profile names with hard-coded API URLs (matches Go's `allProfiles`).
 *
 * `LegacyCliConfig.profile` is typed as `string` (not this union) because Go also
 * supports YAML profile files where `name:` is arbitrary user input. See
 * `legacy-cli-config.layer.ts` for the resolution semantics.
 */
export type LegacyProfileName = "supabase" | "supabase-staging" | "supabase-local" | "snap";

interface LegacyCliConfigShape {
  readonly profile: string;
  readonly apiUrl: string;
  /**
   * Project subdomain host for the active profile (Go's `Profile.ProjectHost`,
   * `apps/cli-go/internal/utils/profile.go`). Used to build the expected CNAME
   * target (`<ref>.<projectHost>`) in `domains create`. Defaults to `supabase.co`
   * for the built-in `supabase` profile.
   */
  readonly projectHost: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly projectId: Option.Option<string>;
  readonly workdir: string;
  readonly userAgent: string;
}

export class LegacyCliConfig extends Context.Service<LegacyCliConfig, LegacyCliConfigShape>()(
  "supabase/legacy/CliConfig",
) {}
