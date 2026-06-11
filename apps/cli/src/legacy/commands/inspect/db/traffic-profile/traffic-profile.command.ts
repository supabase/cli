import { Command } from "effect/unstable/cli";
import { legacyInspectDbTrafficProfile } from "./traffic-profile.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTrafficProfileCommand = Command.make(
  "traffic-profile",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    "Show read/write activity ratio for tables based on block I/O operations.",
  ),
  Command.withShortDescription("Show traffic profile"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTrafficProfile)),
  Command.provide(legacyInspectDbRuntimeLayer("traffic-profile")),
);
