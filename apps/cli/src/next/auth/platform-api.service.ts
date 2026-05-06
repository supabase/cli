import type { ApiClient } from "@supabase/api/effect";
import { ServiceMap } from "effect";

export class PlatformApi extends ServiceMap.Service<PlatformApi, ApiClient>()(
  "supabase/auth/PlatformApi",
) {}
