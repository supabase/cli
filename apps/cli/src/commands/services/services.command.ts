import { Command } from "effect/cli";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../command-internal/command-permissions/model.ts";
import { linkedServiceVersions } from "../../shared/services/services.shared.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import type * as CliCommand from "effect/cli/Command";
import { services } from "./services.handler.ts";
import { servicesRuntimeLayer } from "./services.layers.ts";

const config = {};
export type ServicesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const servicesCommand = Command.make("services", config).pipe(
  Command.withDescription("Show versions of all Supabase services."),
  Command.withShortDescription("Show versions of all Supabase services"),
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
);
