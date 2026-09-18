import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { snippetsDownload } from "./download.handler.ts";

const config = {
  snippetId: Argument.string("snippet-id").pipe(
    Argument.withDescription("ID of the SQL snippet to download."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
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
  Command.withHandler((flags) =>
    snippetsDownload(flags).pipe(
      // No `safeFlags` — `--project-ref` is not on the telemetry-safe list,
      // so the telemetry payload redacts the value.
      withCommandTelemetry({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["snippets", "download"])),
);
