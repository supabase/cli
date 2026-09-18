import { Command } from "effect/unstable/cli";
import { inspectDbTrafficProfile } from "./traffic-profile.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTrafficProfileCommand = Command.make(
  "traffic-profile",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    "Show read/write activity ratio for tables based on block I/O operations.",
  ),
  Command.withShortDescription("Show traffic profile"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTrafficProfile)),
  Command.provide(inspectDbRuntimeLayer("traffic-profile")),
);
