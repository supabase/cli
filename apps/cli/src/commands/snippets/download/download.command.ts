import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { snippetsDownload } from "./download.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  snippetId: cliArgument("snippet-id", Argument.String, {
    description: "ID of the SQL snippet to download.",
    required: true,
  }),
  ...projectTargetFlags(),
};
export type SnippetsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

export const snippetsDownloadCommand = makeCommand("download", config).pipe(
  Command.withDescription(
    "Print the SQL of a snippet to stdout, so you can redirect it to a file. JSON output returns the full snippet payload instead.",
  ),
  Command.withShortDescription("Download a SQL snippet"),
  Command.withExamples([
    {
      command: "supabase snippets download <snippet-id>",
      description: "Download the SQL contents of the given snippet",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-get-a-snippet", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    snippetsDownload(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["snippets", "download"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
