import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { warehouseEnable } from "./enable.handler.ts";

const config = {
  ...projectTargetFlags(),
  schema: Flag.String("schema").pipe(
    Flag.withDescription(
      "Source PostgreSQL schema. Without --table, selects only its currently existing eligible tables; new tables must be added to replication separately.",
    ),
  ),
  table: Flag.String("table").pipe(
    Flag.withDescription("Select only this table in --schema."),
    Flag.optional,
  ),
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Wait for initial synchronization."),
    Flag.withDefault(false),
  ),
  timeout: Flag.String("timeout").pipe(
    Flag.withDescription("Maximum wait for synchronization, for example 15m."),
    Flag.withDefault("15m"),
  ),
} as const;

export type WarehouseEnableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const warehouseEnableCommand = Command.make("enable", config).pipe(
  Command.withDescription(
    "Enable Warehouse for the currently eligible tables in a source schema, or one table with --table. Preview the resolved selection before confirmation. Schema selection includes only the eligible tables that exist when you run this command. Tables created later are not replicated automatically; add them to Warehouse replication separately. Selected partitioned tables include their current and future partitions. Repeating the same selection is safe; use the dashboard to change an enabled Warehouse's replication selection. Without --wait, success means setup was accepted. Use --output-format json for structured output.",
  ),
  Command.withShortDescription("Enable Warehouse replication"),
  Command.withExamples([
    {
      command: "supabase warehouse enable --schema public --wait --timeout 15m",
      description: "Enable Warehouse for the linked project's public schema",
    },
    {
      command:
        "supabase warehouse enable --schema public --table orders --remote=abcdefghijklmnopqrst --yes --output-format json",
      description: "Enable replication of one table without an interactive prompt",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          { operationId: "v2-preview-warehouse-setup", kind: "required" },
          { operationId: "v2-enable-warehouse", kind: "required" },
          {
            operationId: "v2-get-warehouse-setup",
            kind: "required",
            when: [{ flag: "wait", is: true }],
          },
        ],
        noApiEffectFlags: ["schema", "table", "timeout"],
      },
      branchResolution,
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    warehouseEnable(flags).pipe(
      withCommandTelemetry({ flags, outputFormats: GLOBAL_OUTPUT_FORMATS }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["warehouse", "enable"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
