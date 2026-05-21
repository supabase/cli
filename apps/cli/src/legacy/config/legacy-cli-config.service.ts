import type { Option, Redacted } from "effect";
import { Context } from "effect";

export type LegacyProfileName = "supabase" | "supabase-staging" | "supabase-local";

interface LegacyCliConfigShape {
  readonly profile: LegacyProfileName;
  readonly apiUrl: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly projectId: Option.Option<string>;
  readonly workdir: string;
  readonly userAgent: string;
}

export class LegacyCliConfig extends Context.Service<LegacyCliConfig, LegacyCliConfigShape>()(
  "supabase/legacy/CliConfig",
) {}
