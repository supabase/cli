import type { Effect } from "effect";
import { Context } from "effect";

interface BrowserShape {
  readonly open: (url: string) => Effect.Effect<void>;
}

export class Browser extends Context.Service<Browser, BrowserShape>()("supabase/runtime/Browser") {}
