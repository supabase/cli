import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyInspectBaseLayer } from "../inspect.layers.ts";

/**
 * Runtime layer for `supabase inspect report`.
 *
 * `inspect report` is a sibling of `inspect db` (a direct child of `inspect`, not
 * under `db`), so its command-runtime path is `["inspect", "report"]` — two levels,
 * matching Go's `cmd.CommandPath()` (`apps/cli-go/cmd/inspect.go:292`). It shares
 * the same `legacyInspectBaseLayer` (resolver + connection + CLI config + telemetry)
 * as the `db` leaves. `FileSystem` / `Path` / `Tty` / `RuntimeInfo` / `Clock` are
 * provided by the global run harness (`shared/cli/run.ts`), not here.
 */
export const legacyInspectReportRuntimeLayer = Layer.merge(
  legacyInspectBaseLayer,
  commandRuntimeLayer(["inspect", "report"]),
);
