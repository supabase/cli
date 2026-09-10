import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { inspectBaseLayer } from "../inspect.layers.ts";

/**
 * The command-runtime path for a single `inspect db <leaf>` subcommand.
 *
 * The `leaf` is the invoked command's own name (e.g. `"locks"`, or a
 * deprecated alias like `"cache-hit"`) and is appended to `["inspect", "db"]`. This
 * path is what `withCommandTelemetry` records as the PostHog
 * `cli_command_executed` `command` property: the inspect tree is a real 3-level
 * hierarchy, so each of the 26 leaves emits a distinct command name. A shared
 * `["inspect", "db"]` path would collapse them all into one event, so each leaf must
 * pass its own name — and a deprecated alias records the alias the user typed, not
 * the backend command it delegates to.
 */
export const inspectDbCommandPath = (leaf: string): ReadonlyArray<string> => [
  "inspect",
  "db",
  leaf,
];

export const inspectDbRuntimeLayer = (leaf: string) =>
  Layer.merge(inspectBaseLayer, commandRuntimeLayer(inspectDbCommandPath(leaf)));
