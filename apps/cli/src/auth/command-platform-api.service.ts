import type { ApiClient } from "@supabase/api/effect";
import { Context } from "effect";

export class CommandPlatformApi extends Context.Service<CommandPlatformApi, ApiClient>()(
  "supabase/cli/CommandPlatformApi",
) {}
