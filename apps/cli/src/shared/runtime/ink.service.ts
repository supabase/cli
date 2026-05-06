import type { Effect } from "effect";
import { ServiceMap } from "effect";
import type { ReactElement } from "react";

export interface InkInstance {
  readonly unmount: () => void;
  readonly rerender: (element: ReactElement) => void;
  readonly waitUntilExit: () => Promise<unknown>;
}

interface InkShape {
  readonly render: (element: ReactElement) => Effect.Effect<InkInstance>;
}

export class Ink extends ServiceMap.Service<Ink, InkShape>()("supabase/runtime/Ink") {}
