import { Layer } from "effect";
import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../command-internal/command-permissions/model.ts";
import { projectApiKeys } from "../../command-internal/get-api-keys.ts";
import { linkServices } from "../../command-internal/link-services-core.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { organizationPicker } from "../../command-internal/organization-picker.ts";
import { cliConfigValuesLayer } from "../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { cliConfigProviderLayer } from "../../shared/config/cli-config-provider.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { bootstrapRuntimeLayer } from "./bootstrap.layers.ts";
import { bootstrap } from "./bootstrap.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../shared/cli/cli-params.ts";

const config = {
  template: cliArgument("template", Argument.String, {
    description: "Name of the starter template to start from.",
    optional: true,
  }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Password for the new project's Postgres database.",
  }),
} as const;

export type BootstrapFlags = CliCommand.Command.Config.Infer<typeof config>;

export const bootstrapCommand = makeCommand("bootstrap", config).pipe(
  Command.withDescription(
    "Create a new hosted Supabase project from a starter template and link it to a local directory. " +
      "Use it to go from nothing to a running project with one command.\n\n" +
      "The command prompts for a working directory, downloads the template, creates the project, links it, " +
      "writes its connection settings to `.env`, and pushes the template's migrations. " +
      "It logs you in first if needed.\n\n" +
      "Creating a project is a hosted change, so the command asks for confirmation before it starts.",
  ),
  Command.withShortDescription("Create a project from a starter template"),
  Command.withExamples([
    {
      command: "supabase bootstrap",
      description: "Pick a starter template interactively",
    },
    {
      command: "supabase bootstrap my-template",
      description: "Bootstrap from a named starter template",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          { operationId: "v1-create-a-project", kind: "required" },
          { operationId: "v1-get-services-health", kind: "required" },
          {
            operationId: "v1-get-pooler-config",
            kind: "required",
            context:
              "the new project's direct database host is unreachable (IPv4-only network): the migration push connects through the pooler URL this call saves, and without it fails",
          },
        ],
        noApiEffectFlags: ["password"],
      },
      organizationPicker,
      projectApiKeys,
      linkServices,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    // No bootstrap flag is telemetry-safe, so no `safeFlags`.
    bootstrap(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(bootstrapRuntimeLayer.pipe(Layer.provideMerge(cliConfigProviderLayer))),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "account", consent: "yes" }),
);
