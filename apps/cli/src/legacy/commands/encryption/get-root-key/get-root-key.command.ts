import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyEncryptionGetRootKey } from "./get-root-key.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyEncryptionGetRootKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyEncryptionGetRootKeyCommand = Command.make("get-root-key", config).pipe(
  Command.withDescription("Get the root encryption key of a Supabase project."),
  Command.withShortDescription("Get root encryption key"),
  Command.withHandler((flags) => legacyEncryptionGetRootKey(flags)),
);
