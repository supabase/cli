import type { Option, Redacted } from "effect";
import { Context } from "effect";

interface ApiConfigShape {
  readonly baseUrl: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
}

export class ApiConfig extends Context.Service<ApiConfig, ApiConfigShape>()(
  "@supabase/api/ApiConfig",
) {}
