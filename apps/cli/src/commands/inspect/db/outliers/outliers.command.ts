import { Command } from "effect/unstable/cli";
import { legacyInspectDbOutliers } from "./outliers.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbOutliersCommand = Command.make(
  "outliers",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total execution time."),
  Command.withShortDescription("Show query outliers by time"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbOutliers)),
  Command.provide(legacyInspectDbRuntimeLayer("outliers")),
);
