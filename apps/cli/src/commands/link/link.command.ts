import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../command-internal/command-permissions/model.ts";
import { linkServices } from "../../command-internal/link-services-core.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../config/cli-config-values.layer.ts";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { Output } from "../../shared/output/output.service.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { link } from "./link.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";

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
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Password to your remote Postgres database.",
    hidden: true,
  }),
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

const linkHandler = (flags: LinkFlags) =>
  link(flags).pipe(
    withCommandTelemetry({
      flags,
    }),
    withJsonErrorHandling,
  );

const warnPasswordIgnored = Effect.fnUntraced(function* (flags: LinkFlags) {
  if (Option.isNone(flags.password)) return;
  const output = yield* Output;
  yield* output.warn("link ignores --password; remove it from your scripts.");
});

export const linkCommand = Command.make("link", config).pipe(
  Command.withDescription("Link to a Supabase project."),
  Command.withShortDescription("Link to a Supabase project"),
  Command.withExamples([
    {
      command: "supabase link abcdefghijklmnopqrst",
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
  Command.provide(cliConfigValuesLayer),
  // Outermost, so it runs before the management API runtime resolves the access token.
  Command.provideEffectDiscard((flags) => warnPasswordIgnored(flags)),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
