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

const config = {
  template: Argument.String("template").pipe(
    Argument.withDescription("Name of the starter template to bootstrap from."),
    Argument.optional,
  ),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Password to your remote Postgres database.",
  }),
} as const;

export type BootstrapFlags = CliCommand.Command.Config.Infer<typeof config>;

export const bootstrapCommand = Command.make("bootstrap", config).pipe(
  Command.withDescription("Bootstrap a Supabase project from a starter template."),
  Command.withShortDescription("Bootstrap a Supabase project from a starter template"),
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
