import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyEncryptionUpdateRootKey } from "./update-root-key.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyEncryptionUpdateRootKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyEncryptionUpdateRootKeyCommand = Command.make("update-root-key", config).pipe(
  Command.withDescription("Update root encryption key of a Supabase project."),
  Command.withShortDescription("Update the root encryption key"),
  Command.withHandler((flags) => legacyEncryptionUpdateRootKey(flags)),
);
