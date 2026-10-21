import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  type EntryCondition,
} from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesGet } from "./get.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";

// `get.handler.ts` skips the api-keys and pooler calls for `-o pretty`, and with no `-o` when the output format is text.
const MACHINE_OUTPUT: ReadonlyArray<{
  readonly when: ReadonlyArray<EntryCondition>;
  readonly context?: string;
}> = [
  { when: [{ flag: "output", oneOf: ["env", "json", "toml", "yaml", "table", "csv"] }] },
  {
    when: [
      { flag: "output", present: false },
      { flag: "output-format", oneOf: ["json", "stream-json"] },
    ],
  },
  {
    when: [
      { flag: "output", present: false },
      { flag: "output-format", present: false },
      { flag: "agent", oneOf: ["yes"] },
    ],
  },
  {
    when: [
      { flag: "output", present: false },
      { flag: "output-format", present: false },
      { flag: "agent", oneOf: ["auto"] },
    ],
    context: "a coding agent is detected in the environment",
  },
];

const config = {
  name: Argument.String("name").pipe(
    Argument.withDescription("Branch name or ID."),
    Argument.optional,
  ),
  ...projectTargetFlags({ parent: true }),
} as const;

export type BranchesGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesGetCommand = Command.make("get", config).pipe(
  Command.withDescription(
    "Retrieve details of the specified preview branch.\n\nNote: For the main branch, password-dependent fields (POSTGRES_URL, POSTGRES_URL_NON_POOLING) are not populated because production database credentials are not retrievable via API.",
  ),
  Command.withShortDescription("Retrieve details of a preview branch"),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-get-a-branch",
            kind: "required",
            context:
              "the branch given (argument or typed answer) is a name, not a UUID or a 20-letter project ref",
          },
          { operationId: "v1-get-a-branch-config", kind: "required" },
          ...MACHINE_OUTPUT.flatMap(({ when, context }) =>
            ["v1-get-project-api-keys", "v1-get-pooler-config"].map((operationId) => ({
              operationId,
              kind: "required" as const,
              when,
              ...(context === undefined ? {} : { context }),
            })),
          ),
        ],
      },
      branchesParentTarget,
      projectRefPicker,
      branchPrompt,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesGet(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "get"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
