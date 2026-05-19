import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withHidden, withHiddenFromConfig } from "../../../shared/cli/hidden-flag.ts";
import { legacyStop } from "./stop.handler.ts";

const config = {
  projectId: Flag.string("project-id").pipe(
    Flag.withDescription("Local project ID to stop."),
    Flag.optional,
  ),
  // Hidden boolean kept for Go CLI parity: `--backup=false` is the historical
  // way to skip the backup and is functionally identical to `--no-backup`.
  backup: withHidden(
    Flag.boolean("backup").pipe(
      Flag.withDescription("Backs up the current database before stopping."),
      Flag.withDefault(true),
    ),
  ),
  noBackup: Flag.boolean("no-backup").pipe(
    Flag.withDescription("Deletes all data volumes after stopping."),
  ),
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Stop all local Supabase instances from all projects across the machine."),
  ),
} as const;

export type LegacyStopFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStopCommand = Command.make("stop", config).pipe(
  Command.withDescription("Stop all local Supabase containers."),
  Command.withShortDescription("Stop all local Supabase containers"),
  withHiddenFromConfig(config),
  Command.withHandler((flags) => legacyStop(flags)),
);
