import type { Option, Redacted } from "effect";
import { Context } from "effect";

/**
 * Built-in profile names with hard-coded API URLs.
 *
 * `LegacyCliSettings.profile` is typed as `string` (not this union) because
 * this also supports YAML profile files where `name:` is arbitrary user
 * input. See `legacy-cli-settings.layer.ts` for the resolution semantics.
 */
export type LegacyProfileName = "supabase" | "supabase-staging" | "supabase-local" | "snap";

interface LegacyCliSettingsShape {
  readonly profile: string;
  readonly apiUrl: string;
  /**
   * Project subdomain host for the active profile. Used to build the
   * expected CNAME target (`<ref>.<projectHost>`) in `domains create`.
   * Defaults to `supabase.co` for the built-in `supabase` profile.
   */
  readonly projectHost: string;
  /**
   * eTLD+1 the connection pooler hostname must belong to. Sourced from the
   * resolved profile — the built-in table for named profiles, or the
   * `pooler_host:` key of a YAML profile file — so custom/staging pooler
   * domains are honored. An empty string means "no pooler-domain assertion"
   * (the case for the built-in `supabase-local` profile). Used by the linked
   * db-config resolver's MITM domain check.
   */
  readonly poolerHost: string;
  /**
   * Dashboard base URL for the active profile. Sourced from the resolved
   * profile — the built-in table for named profiles, or the
   * `dashboard_url:` key of a YAML profile file — so staging/custom
   * dashboards are honored. Used by the connect-failure suggestion
   * (network-restrictions hint).
   */
  readonly dashboardUrl: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly projectId: Option.Option<string>;
  readonly workdir: string;
  readonly userAgent: string;
}

export class LegacyCliSettings extends Context.Service<LegacyCliSettings, LegacyCliSettingsShape>()(
  "supabase/legacy/CliSettings",
) {}
