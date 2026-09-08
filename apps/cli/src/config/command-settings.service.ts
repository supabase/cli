import type { Option, Redacted } from "effect";
import { Context } from "effect";

/**
 * Built-in profile names with hard-coded API URLs.
 *
 * `CommandSettings.profile` is typed as `string` (not this union) because
 * this also supports YAML profile files where `name:` is arbitrary user
 * input. See `command-settings.layer.ts` for the resolution semantics.
 */
export type ProfileName = "supabase" | "supabase-staging" | "supabase-local" | "snap";

interface CommandSettingsShape {
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
  /**
   * Whether {@link workdir} came from an explicit `--workdir`/`SUPABASE_WORKDIR`
   * (used exactly as given) rather than the default ancestor walk-up. True iff
   * the resolution did NOT climb.
   *
   * Config loads that accept `supabase/config.json` must pass
   * `search: shouldSearchAncestors(cliSettings)` to
   * `loadCliConfig`/`findCliProjectPaths`/`findCliProjectRoot` — see
   * `shouldSearchAncestors` (`command-internal/workdir-search.ts`)
   * for the full rule and why callers that also pass `tomlOnly: true` instead
   * pass `search: false` unconditionally. A load that also tolerates a `null`
   * result carries a paired obligation for that rule's 4th point: hard-fail
   * when `explicitWorkdir` is true unless it's one of the documented
   * exceptions — see `missingProjectConfigMessage`/
   * `requireExplicitWorkdirProject` (`command-internal/workdir-project.ts`).
   */
  readonly explicitWorkdir: boolean;
  readonly userAgent: string;
}

export class CommandSettings extends Context.Service<CommandSettings, CommandSettingsShape>()(
  "supabase/cli/CommandSettings",
) {}
