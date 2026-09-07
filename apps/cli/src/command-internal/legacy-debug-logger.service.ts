import type { Effect } from "effect";
import { Context } from "effect";

export interface LegacyDebugLoggerShape {
  readonly debug: (message: string) => Effect.Effect<void>;
  readonly http: (method: string, url: string) => Effect.Effect<void>;
}

export class LegacyDebugLogger extends Context.Service<LegacyDebugLogger, LegacyDebugLoggerShape>()(
  "supabase/legacy/DebugLogger",
) {}
