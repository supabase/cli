import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySnippetsDownload } from "./download.handler.ts";

const config = {
  snippetId: Argument.string("snippet-id").pipe(
    Argument.withDescription("ID of the SQL snippet to download."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type LegacySnippetsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySnippetsDownloadCommand = Command.make("download", config).pipe(
  Command.withDescription("Download contents of the specified SQL snippet."),
  Command.withShortDescription("Download contents of a SQL snippet"),
  Command.withExamples([
    {
      command: "supabase snippets download <snippet-id>",
      description: "Download the SQL contents of the given snippet",
    },
  ]),
  Command.withHandler((flags) =>
    legacySnippetsDownload(flags).pipe(
      // No `safeFlags` — Go's `cmd/snippets.go` does not call
      // `markFlagTelemetrySafe` for `--project-ref`, so the telemetry payload
      // redacts the value.
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["snippets", "download"])),
);
