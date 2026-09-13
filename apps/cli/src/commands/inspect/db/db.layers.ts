import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { inspectBaseLayer } from "../inspect.layers.ts";

/**
 * The command-runtime path for a single `inspect db <leaf>` subcommand, appended to
 * `["inspect", "db"]` so each of the 25 leaves — and each deprecated alias — records its own
 * name in `cli_command_executed`, not a shared "inspect db" event.
 */
export const inspectDbCommandPath = (leaf: string): ReadonlyArray<string> => [
  "inspect",
  "db",
  leaf,
];

export const inspectDbRuntimeLayer = (leaf: string) =>
  Layer.merge(inspectBaseLayer, commandRuntimeLayer(inspectDbCommandPath(leaf)));
