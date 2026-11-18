import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { notebookCreate, notebookRead, notebooksList } from "../notebooks.shared.ts";
import { notebooksPush } from "./push.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  notebookName: cliArgument("Notebook name", Argument.String, {
    description: "Name of the notebook to push; pushes all when omitted.",
    optional: true,
  }),
  ...projectTargetFlags(),
} as const;

export type NotebooksPushFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const notebooksPushHandler = (flags: NotebooksPushFlags) =>
  notebooksPush(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling);

export const notebooksPushCommand = makeCommand("push", config).pipe(
  Command.withDescription(
    "Upload the notebooks in `supabase/notebooks` to the linked project.\n\nWhen you push all notebooks, the command asks what to do about project notebooks that the directory does not have.",
  ),
  Command.withShortDescription("Push local notebooks to a project"),
  Command.withExamples([
    {
      command: "supabase notebooks push",
      description: "Push every notebook in supabase/notebooks to the linked project",
    },
    {
      command: "supabase notebooks push sales-dashboard",
      description: "Push a single notebook by name",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v2-update-notebook",
            kind: "required",
            context: "a notebook file whose name a project notebook carries",
          },
          {
            operationId: "v2-delete-notebook",
            kind: "required",
            context:
              "no notebook name argument, project notebooks with no local file, stdout a TTY with text output, and the delete answer",
          },
        ],
      },
      projectRefPicker,
      notebooksList,
      withContext(notebookCreate, "a notebook file whose name no project notebook carries"),
      withContext(
        notebookRead,
        "no notebook name argument, project notebooks with no local file, stdout a TTY with text output, and the write-locally answer",
      ),
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler(notebooksPushHandler),
  Command.provide(managementApiRuntimeLayer(["notebooks", "push"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
