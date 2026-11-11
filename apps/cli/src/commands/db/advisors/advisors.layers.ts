import { Layer } from "effect";
import { advisorChecksRuntimeLayer } from "../../../command-internal/advisors/advisors.layers.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

export const dbAdvisorsRuntimeLayer = Layer.merge(
  advisorChecksRuntimeLayer,
  commandRuntimeLayer(["db", "advisors"]),
);
