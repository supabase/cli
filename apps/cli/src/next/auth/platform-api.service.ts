import type { ApiClient } from "@supabase/api/effect";
import { Context } from "effect";

export class PlatformApi extends Context.Service<PlatformApi, ApiClient>()(
  "supabase/auth/PlatformApi",
) {}
