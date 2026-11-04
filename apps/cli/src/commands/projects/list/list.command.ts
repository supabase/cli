import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withDocs } from "../../../docs/command-docs.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../../command-internal/command-permissions/model.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsList } from "./list.handler.ts";
import { ProjectsListJsonOutput } from "./list.json-output.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {};
export type ProjectsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsListCommand = makeCommand("list", config).pipe(
  Command.withDescription(
    "Show the projects the logged-in user can access. The project linked to the current directory is marked.",
  ),
  Command.withShortDescription("List all projects"),
  withDocs({
    category: "projects",
    jsonOutput: ProjectsListJsonOutput,
    examples: [
      {
        id: "example-1",
        name: "List all projects",
        code: "supabase projects list",
        output: "recorded",
        scenario: "docs-projects-list",
        response: `

   LINKED | ORG ID               | REFERENCE ID         | NAME       | REGION                   | CREATED AT (UTC)
  --------|----------------------|----------------------|------------|--------------------------|---------------------
     ●    | qzrwtxnbvclphkmdsjyg | xkvpqmdrbtwnjzhcuaoe | My Project | East US (North Virginia) | 2025-03-14 09:21:07
          | mhdgfkwpsyjzbtlcvqne | gyfsleibnmkwxrdqzthv | Staging    | West EU (Ireland)        | 2025-06-02 15:48:33

`,
      },
      {
        id: "example-2",
        name: "Machine-readable JSON output",
        code: "supabase projects list --output-format json",
        output: "recorded",
        scenario: "docs-projects-list",
        response: `{"projects":[{"id":"xkvpqmdrbtwnjzhcuaoe","ref":"xkvpqmdrbtwnjzhcuaoe","organization_id":"qzrwtxnbvclphkmdsjyg","organization_slug":"qzrwtxnbvclphkmdsjyg","name":"My Project","region":"us-east-1","status":"ACTIVE_HEALTHY","database":{"host":"db.xkvpqmdrbtwnjzhcuaoe.supabase.red","version":"17.6.1.084","postgres_engine":"17","release_channel":"ga"},"created_at":"2025-03-14T09:21:07Z","linked":true},{"id":"gyfsleibnmkwxrdqzthv","ref":"gyfsleibnmkwxrdqzthv","organization_id":"mhdgfkwpsyjzbtlcvqne","organization_slug":"mhdgfkwpsyjzbtlcvqne","name":"Staging","region":"eu-west-1","status":"ACTIVE_HEALTHY","database":{"host":"db.gyfsleibnmkwxrdqzthv.supabase.red","version":"17.6.1.111","postgres_engine":"17","release_channel":"ga"},"created_at":"2025-06-02T15:48:33Z","linked":false}],"message":""}
`,
      },
    ],
  }),
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
  Command.withHandler((flags) =>
    projectsList(flags).pipe(withCommandTelemetry({ flags, safeFlags: [] }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "list"])),
  withTargetPolicy({ group: "account", consent: "none" }),
);
