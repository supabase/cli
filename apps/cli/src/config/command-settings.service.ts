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
  /** Raw SUPABASE_PROFILE value; Some("") differs from an absent variable. */
  readonly profileEnvValue: Option.Option<string>;
  /** Resolved global state directory used for profiles and credentials. */
  readonly supabaseHome: string;
  /**
   * Project subdomain host for the active profile. Used to build the
   * expected CNAME target (`<ref>.<projectHost>`) in `domains create`.
   * Defaults to `supabase.co` for the built-in `supabase` profile.
   */
  readonly projectHost: string;
  /**
   * eTLD+1 the connection pooler hostname must belong to, used by the linked db-config
   * resolver's MITM domain check. An empty string disables that assertion (the
   * `supabase-local` case).
   */
  readonly poolerHost: string;
  /** Dashboard base URL for the active profile, used by the connect-failure network-restrictions hint. */
  readonly dashboardUrl: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  /** `SUPABASE_DB_PASSWORD` captured at settings resolution; empty captures as none. */
  readonly dbPassword: Option.Option<Redacted.Redacted<string>>;
  /** Ambient `GITHUB_TOKEN`; raises anonymous GitHub API rate limits. Empty captures as none. */
  readonly githubToken: Option.Option<Redacted.Redacted<string>>;
  readonly projectId: Option.Option<string>;
  readonly workdir: string;
  /**
   * Whether {@link workdir} came from an explicit `--workdir`/`SUPABASE_WORKDIR` rather than
   * the default ancestor walk-up. Config loads use it to decide whether to search ancestor
   * directories; see `shouldSearchAncestors` in `command-internal/workdir-search.ts`.
   */
  readonly explicitWorkdir: boolean;
  /** Raw `SUPABASE_WORKDIR` value; `Some("")` differs from an absent variable and is used verbatim. */
  readonly workdirEnvValue: Option.Option<string>;
  readonly userAgent: string;
}

export class CommandSettings extends Context.Service<CommandSettings, CommandSettingsShape>()(
  "supabase/cli/CommandSettings",
) {}
