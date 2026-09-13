import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { inspectBaseLayer } from "../inspect.layers.ts";

/**
 * Runtime layer for `supabase inspect report`.
 *
 * `FileSystem` / `Path` / `Tty` / `RuntimeInfo` / `Clock` come from the global run harness
 * (`shared/cli/run.ts`), not here.
 */
export const inspectReportRuntimeLayer = Layer.merge(
  inspectBaseLayer,
  commandRuntimeLayer(["inspect", "report"]),
);
