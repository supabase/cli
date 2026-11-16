import type { Effect } from "effect";
import { Context } from "effect";

export interface DebugLoggerShape {
  readonly debug: (message: string) => Effect.Effect<void>;
  readonly http: (method: string, url: string) => Effect.Effect<void>;
}

export class DebugLogger extends Context.Service<DebugLogger, DebugLoggerShape>()(
  "supabase/cli/DebugLogger",
) {}
