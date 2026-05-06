import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbIndexSizes } from "./index-sizes.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
} as const;

export type LegacyInspectDbIndexSizesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbIndexSizesCommand = Command.make("index-sizes", config).pipe(
  Command.withDescription(
    'Show index sizes of individual indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show individual index sizes (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbIndexSizes(flags)),
);
