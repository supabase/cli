import { Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { PROJECT_REF_PATTERN } from "../../config/remote-target.service.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../command-internal/command-permissions/model.ts";
import { linkServices } from "../../command-internal/link-services-core.ts";
import { projectRefPicker } from "../../config/remote-target.layer.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { link } from "./link.handler.ts";

const config = {
  refOrBranch: Argument.String("ref-or-branch").pipe(
    Argument.withDescription(
      "Project ref, or the name (or UUID) of a branch of the currently linked project. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Argument.optional,
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name of one of its branches.",
    ),
    Flag.optional,
  ),
  password: Flag.String("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  skipPooler: Flag.Boolean("skip-pooler").pipe(
    Flag.withDescription("Use direct connection instead of pooler."),
    Flag.withDefault(false),
  ),
  frozen: Flag.Boolean("frozen").pipe(
    Flag.withDescription("Leave supabase/supabase.lock untouched (stack mode only)."),
    Flag.withDefault(false),
    Flag.withHidden,
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
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-list-all-branches",
            kind: "required",
            context:
              "the [ref-or-branch] argument or --project-ref is a branch name or UUID, not a 20-letter project ref",
          },
          { operationId: "v1-get-project", kind: "required" },
          {
            operationId: "v1-get-project-api-keys",
            kind: "required",
            request: { query: { reveal: "true" } },
          },
          {
            operationId: "v1-get-a-branch-config",
            kind: "best-effort",
            context:
              "stack mode, supabase/config.toml exists, and the project lookup returns 404 (the ref is a branch)",
          },
          {
            operationId: "v1-list-all-branches",
            kind: "best-effort",
            context:
              "the project lookup returns 404 (the ref is a branch), the ref was not resolved from a branch name, and supabase/.temp/linked-project.json names a different project",
          },
        ],
        noApiEffectFlags: ["password", "frozen"],
      },
      withContext(projectRefPicker, "no [ref-or-branch] argument"),
      linkServices,
      linkedProjectCache,
    ),
  ),
  Command.withHandler(linkHandler),
  Command.provide(managementApiRuntimeLayer(["link"])),
);
