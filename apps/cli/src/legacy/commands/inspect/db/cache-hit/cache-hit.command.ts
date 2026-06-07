import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbCacheHit } from "./cache-hit.handler.ts";

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

export type LegacyInspectDbCacheHitFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbCacheHitCommand = Command.make("cache-hit", config).pipe(
  Command.withDescription(
    'Show cache hit rates for tables and indices. Deprecated: use "db-stats" instead.',
  ),
  Command.withShortDescription("Show cache hit rates (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbCacheHit(flags)),
);
