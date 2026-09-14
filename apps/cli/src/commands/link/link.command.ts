import { Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { link } from "./link.handler.ts";

const config = {
  refOrBranch: Argument.string("ref-or-branch").pipe(
    Argument.withDescription(
      "Project ref, or the name (or UUID) of a branch of the currently linked project. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name of one of its branches.",
    ),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  skipPooler: Flag.boolean("skip-pooler").pipe(
    Flag.withDescription("Use direct connection instead of pooler."),
    Flag.withDefault(false),
  ),
} as const;

export type LinkFlags = CliCommand.Command.Config.Infer<typeof config>;

export const linkHandler = (flags: LinkFlags) =>
  link(flags).pipe(
    // `--project-ref` is only safe to log verbatim when it's ref-shaped — it can also be a
    // branch name, which is user data. `--skip-pooler` is always safe; `--password` stays redacted.
    withCommandTelemetry({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
    }),
    withJsonErrorHandling,
  );

export const linkCommand = Command.make("link", config).pipe(
  Command.withDescription("Link to a Supabase project."),
  Command.withShortDescription("Link to a Supabase project"),
  Command.withExamples([
    {
      command: "supabase link --project-ref abcdefghijklmnopqrst",
      description: "Link to a project by ref",
    },
    {
      command: "supabase link my-branch",
      description: "Link to a branch of the currently linked project by name",
    },
  ]),
  Command.withHandler(linkHandler),
  Command.provide(managementApiRuntimeLayer(["link"])),
);
