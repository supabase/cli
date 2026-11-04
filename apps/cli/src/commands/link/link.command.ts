import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withDocs } from "../../docs/command-docs.ts";
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
import body from "./link.docs.md" with { type: "text" };
import { link } from "./link.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../shared/cli/cli-params.ts";

const config = {
  refOrBranch: cliArgument("ref-or-branch", Argument.String, {
    description:
      "Project ref, or the name or UUID of a branch of the linked project; 20 lowercase letters are always read as a project ref.",
    optional: true,
  }),
  projectRef: cliFlag("project-ref", Flag.String, {
    description: "Project ref, or the name of one of its branches; deprecated in favor of the argument.",
    optional: true,
  }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Password to your remote Postgres database.",
    hidden: true,
  }),
  skipPooler: cliFlag("skip-pooler", Flag.Boolean, {
    description: "Use a direct connection instead of the connection pooler.",
    default: false,
  }),
  frozen: cliFlag("frozen", Flag.Boolean, {
    description: "Leave supabase/supabase.lock untouched in stack mode.",
    default: false,
    hidden: true,
  }),
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

export const linkCommand = makeCommand("link", config).pipe(
  Command.withDescription("Link the local project to a hosted Supabase project."),
  Command.withShortDescription("Link to a hosted Supabase project"),
  withDocs({
    category: "general",
    body,
    examples: [
      {
        id: "basic-usage",
        name: "Basic usage",
        code: "supabase link ********************",
        response: `Enter your database password (or leave blank to skip): ********
Finished supabase link.
`,
      },
      {
        id: "without-password",
        name: "Link without database password",
        code: 'supabase link ******************** <<< ""',
        response: `Enter your database password (or leave blank to skip):
Finished supabase link.
`,
      },
      {
        id: "using-alternate-dns",
        name: "Link using DNS-over-HTTPS resolver",
        code: "supabase link ******************** --dns-resolver https",
        response: `Enter your database password (or leave blank to skip):
Finished supabase link.
`,
      },
    ],
  }),
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
            kind: "best-effort",
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
