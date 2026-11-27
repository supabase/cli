import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../../command-internal/command-permissions/model.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withLegacyOutputHandler } from "../../../command-internal/command-executor.ts";
import { managementApiRuntime } from "../../../command-internal/management-api-runtime.layer.ts";
import { projectsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {};
export type ProjectsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all Supabase projects the logged-in user can access."),
  Command.withShortDescription("List all projects"),
  Command.withExamples([
    {
      command: "supabase projects list",
      description: "List all projects",
    },
    {
      command: "supabase projects list --output-format json",
      description: "Machine-readable JSON output",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-projects", kind: "required" }] },
      withContext(
        linkedProjectCache,
        "a linked ref from SUPABASE_PROJECT_ID or supabase/.temp/project-ref",
      ),
    ),
  ),
  withLegacyOutputHandler({
    handler: projectsList,
    runtime: managementApiRuntime(["projects", "list"]),
  }),
  withTargetPolicy({ group: "account", consent: "none" }),
);
