import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { genKeys } from "./keys.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  overrideName: Flag.String("override-name").pipe(
    Flag.withDescription("Override specific variable names."),
    Flag.atLeast(0),
  ),
} as const;

export type GenKeysFlags = CliCommand.Command.Config.Infer<typeof config>;

export const genKeysCommand = Command.make("keys", config).pipe(
  Command.withDescription(
    'Generate keys for preview branch. Deprecated: use "gen signing-key" instead.',
  ),
  Command.withShortDescription("Generate keys for preview branch (experimental)"),
  Command.withHandler((flags) => genKeys(flags)),
);
