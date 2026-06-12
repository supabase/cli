import { Command } from "effect/unstable/cli";
import { legacyInspectDbIndexSizes } from "./index-sizes.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbIndexSizesCommand = Command.make(
  "index-sizes",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show index sizes of individual indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show individual index sizes (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbIndexSizes)),
  Command.provide(legacyInspectDbRuntimeLayer("index-sizes")),
);
