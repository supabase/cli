import { Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { PROJECT_REF_PATTERN } from "../../config/legacy-project-ref.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyLink } from "./link.handler.ts";

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
  ),
} as const;

export type LegacyLinkFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyLinkHandler = (flags: LegacyLinkFlags) =>
  legacyLink(flags).pipe(
    // Only `--project-ref` is `markFlagTelemetrySafe` in Go (cmd/link.go:52).
    // The boolean `--skip-pooler` is logged verbatim regardless; `--password`
    // stays redacted. CLI-2167: `--project-ref` now also accepts a branch
    // name, so it's only safe to log verbatim when it's actually ref-shaped
    // — otherwise a user-created branch name would leak to PostHog verbatim.
    withLegacyCommandInstrumentation({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
    }),
    withJsonErrorHandling,
  );

export const legacyLinkCommand = Command.make("link", config).pipe(
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
  Command.withHandler(legacyLinkHandler),
  Command.provide(legacyManagementApiRuntimeLayer(["link"])),
);
