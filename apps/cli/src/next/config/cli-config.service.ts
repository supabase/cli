import type { Option, Redacted } from "effect";
import { ServiceMap } from "effect";

interface CliConfigShape {
  readonly apiUrl: string;
  readonly dashboardUrl: string;
  readonly projectHost: string;
  readonly telemetryPosthogHost: string;
  readonly telemetryPosthogKey: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly noKeyring: Option.Option<string>;
  readonly supabaseHome: string;
  readonly debug: Option.Option<string>;
  readonly telemetryDebug: Option.Option<string>;
  readonly telemetryDisabled: Option.Option<string>;
  readonly doNotTrack: Option.Option<string>;
}

export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()(
  "@supabase/cli/config/CliConfig",
) {}
