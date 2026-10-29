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

const config = {
  snippetId: Argument.String("snippet-id").pipe(
    Argument.withDescription("ID of the SQL snippet to download."),
  ),
  ...projectTargetFlags(),
};
export type SnippetsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

export const snippetsDownloadCommand = Command.make("download", config).pipe(
  Command.withDescription("Download contents of the specified SQL snippet."),
  Command.withShortDescription("Download contents of a SQL snippet"),
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
