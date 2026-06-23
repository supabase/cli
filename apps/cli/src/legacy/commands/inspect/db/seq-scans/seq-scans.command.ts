import { Command } from "effect/unstable/cli";
import { legacyInspectDbSeqScans } from "./seq-scans.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbSeqScansCommand = Command.make(
  "seq-scans",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show number of sequential scans recorded against all tables. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show sequential scans (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbSeqScans)),
  Command.provide(legacyInspectDbRuntimeLayer("seq-scans")),
);
