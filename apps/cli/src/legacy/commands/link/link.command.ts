import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyLink } from "./link.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  skipPooler: Flag.boolean("skip-pooler").pipe(
    Flag.withDescription("Use direct connection instead of pooler."),
  ),
} as const;

export type LegacyLinkFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyLinkCommand = Command.make("link", config).pipe(
  Command.withDescription("Link to a Supabase project."),
  Command.withShortDescription("Link to a Supabase project"),
  Command.withHandler((flags) => legacyLink(flags)),
);
