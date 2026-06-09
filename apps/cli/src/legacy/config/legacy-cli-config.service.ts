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
  /**
   * eTLD+1 the connection pooler hostname must belong to (Go's `Profile.PoolerHost`,
   * `apps/cli-go/internal/utils/profile.go:23`). Sourced from the resolved profile —
   * the built-in table for named profiles, or the `pooler_host:` key of a YAML
   * profile file — so custom/staging pooler domains are honored. An empty string
   * means "no pooler-domain assertion" (Go's `supabase-local`). Used by the linked
   * db-config resolver's MITM domain check.
   */
  readonly poolerHost: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly projectId: Option.Option<string>;
  readonly workdir: string;
  readonly userAgent: string;
}

export class LegacyCliConfig extends Context.Service<LegacyCliConfig, LegacyCliConfigShape>()(
  "supabase/legacy/CliConfig",
) {}
