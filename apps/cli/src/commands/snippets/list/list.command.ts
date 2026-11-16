import { Command } from "effect/cli";
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
import { snippetsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
};
export type SnippetsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const snippetsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all SQL snippets of the linked project."),
  Command.withShortDescription("List all SQL snippets"),
  Command.withExamples([
    {
      command: "supabase snippets list",
      description: "List all SQL snippets",
    },
    {
      command: "supabase snippets list --remote=<ref>",
      description: "List snippets for a specific project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-snippets", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    snippetsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["snippets", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
