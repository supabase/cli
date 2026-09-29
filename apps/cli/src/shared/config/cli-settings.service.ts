import type { Option, Redacted } from "effect";
import { Context } from "effect";

interface CliSettingsShape {
  readonly apiUrl: string;
  readonly dashboardUrl: string;
  readonly projectHost: string;
  readonly telemetryPosthogHost: string;
  readonly telemetryPosthogKey: Option.Option<string>;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly noKeyring: Option.Option<string>;
  readonly supabaseHome: string;
  readonly telemetryDisabled: Option.Option<string>;
  readonly doNotTrack: Option.Option<string>;
}

export class CliSettings extends Context.Service<CliSettings, CliSettingsShape>()(
  "supabase/cli/CliSettings",
) {}
