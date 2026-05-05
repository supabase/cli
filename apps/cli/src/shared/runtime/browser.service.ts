import type { Effect } from "effect";
import { ServiceMap } from "effect";

interface BrowserShape {
  readonly open: (url: string) => Effect.Effect<void>;
}

export class Browser extends ServiceMap.Service<Browser, BrowserShape>()(
  "@supabase/cli/runtime/Browser",
) {}
