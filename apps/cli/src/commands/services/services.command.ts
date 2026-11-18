import { Command } from "effect/cli";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../command-internal/command-permissions/model.ts";
import { linkedServiceVersions } from "../../shared/services/services.shared.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import type * as CliCommand from "effect/cli/Command";
import { services } from "./services.handler.ts";
import { servicesRuntimeLayer } from "./services.layers.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { makeCommand } from "../../shared/cli/cli-params.ts";

const config = {};
export type ServicesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const servicesCommand = makeCommand("services", config).pipe(
  Command.withDescription(
    "Show the version of each Supabase service in your local stack and, when the project is linked, the version running on the hosted project. Use it to spot a local stack that lags behind.",
  ),
  Command.withShortDescription("Show Supabase service versions"),
  Command.withExamples([
    {
      command: "supabase services",
      description: "Show local and linked service versions",
    },
  ]),
  withPermissions(
    compose(
      withContext(
        linkedServiceVersions,
        "a 20-letter linked project ref (SUPABASE_PROJECT_ID, else supabase/.temp/project-ref) and an access token",
      ),
      withContext(
        linkedProjectCache,
        "a linked project ref (SUPABASE_PROJECT_ID, else supabase/.temp/project-ref; not format-checked)",
      ),
    ),
  ),
  Command.withHandler((flags) =>
    services(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(servicesRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
