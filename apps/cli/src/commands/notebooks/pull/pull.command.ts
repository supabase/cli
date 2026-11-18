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
import { notebooksPull } from "./pull.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  notebookId: cliArgument("Notebook id", Argument.String, {
    description:
      "UUID of the notebook to replace locally; pulls only missing notebooks when omitted.",
    optional: true,
  }),
  ...projectTargetFlags(),
} as const;

export type NotebooksPullFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const notebooksPullHandler = (flags: NotebooksPullFlags) =>
  notebooksPull(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling);

export const notebooksPullCommand = makeCommand("pull", config).pipe(
  Command.withDescription(
    "Write the notebooks of the linked project to `supabase/notebooks`.\n\nWithout a notebook id, existing local files are kept and only missing notebooks are written.",
  ),
  Command.withShortDescription("Pull notebooks from a project"),
  Command.withExamples([
    {
      command: "supabase notebooks pull",
      description: "Pull every notebook from the linked project",
    },
    {
      command: "supabase notebooks pull 44444444-4444-4444-8444-444444444444",
      description: "Replace the local copy of one notebook by id",
    },
  ]),
  withPermissions(
    compose(
      { operations: [] },
      projectRefPicker,
      withContext(notebooksList, "no notebook id argument"),
      withContext(
        notebookRead,
        "a notebook id argument, or no id argument and a project notebook with no file in supabase/notebooks",
      ),
      withContext(
        notebookCreate,
        "no notebook id argument, local notebooks the project lacks, stdout a TTY with text output, and the create answer",
      ),
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler(notebooksPullHandler),
  Command.provide(managementApiRuntimeLayer(["notebooks", "pull"])),
  withTargetPolicy({
    group: "hosted",
    consent: "none",
    consentExemptReason: "creates project notebooks only after an interactive reconcile choice",
  }),
);
