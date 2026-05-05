import type { Option, Redacted } from "effect";
import { ServiceMap } from "effect";

interface ApiConfigShape {
  readonly baseUrl: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
}

export class ApiConfig extends ServiceMap.Service<ApiConfig, ApiConfigShape>()(
  "@supabase/api/ApiConfig",
) {}
