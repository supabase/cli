import type { ApiClient } from "@supabase/api/effect";
import { Context } from "effect";

export class LegacyPlatformApi extends Context.Service<LegacyPlatformApi, ApiClient>()(
  "supabase/legacy/PlatformApi",
) {}
