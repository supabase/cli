import { Duration, Effect, Option, Schedule, Schema } from "effect";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { parseDuration } from "../../../command-internal/duration.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { mapHttpError, sanitizeInlineName } from "../../../command-internal/http-errors.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { WarehouseEnableFlags } from "./enable.command.ts";
import {
  WarehouseEnableIncompleteError,
  WarehouseEnableInputError,
  WarehouseEnableNetworkError,
  WarehouseEnableStatusError,
  WarehouseEnableTimeoutError,
} from "./enable.errors.ts";

const errorEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
  ),
);
const mapError = mapHttpError({
  networkError: WarehouseEnableNetworkError,
  statusError: WarehouseEnableStatusError,
  networkMessage: (cause) => `Warehouse request failed: ${cause}`,
  statusMessage: (status, body) => {
    const envelope = errorEnvelope(body);
    if (Option.isNone(envelope)) {
      return `Warehouse request failed (${status}): ${body}`;
    }
    const { code, message } = envelope.value.error;
    const sanitizedMessage = sanitizeInlineName(message);
    switch (code) {
      case "warehouse_selection_conflict":
        return `${sanitizedMessage} Use warehouse replication add/remove to change the existing selection.`;
      case "warehouse_preview_stale":
        return `${sanitizedMessage} Run this command again to review the changed selection.`;
      default:
        return sanitizedMessage;
    }
  },
});

export const warehouseEnable = Effect.fn("warehouse.enable")(function* (
  flags: WarehouseEnableFlags,
) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const cache = yield* LinkedProjectCache;
  const telemetry = yield* TelemetryState;
  const run = Effect.gen(function* () {
    if (Option.isSome(outputFlag)) {
      return yield* new WarehouseEnableInputError({
        message: unsupportedOutputFlagMessage("warehouse enable"),
      });
    }
    if (!flags.schema.length || (Option.isSome(flags.table) && !flags.table.value.length)) {
      return yield* new WarehouseEnableInputError({
        message: "--schema and --table must not be empty.",
      });
    }
    const timeout = yield* Effect.try({
      try: () => parseDuration(flags.timeout) / 1_000_000,
      catch: () =>
        new WarehouseEnableInputError({
          message: "--timeout must be a positive duration, for example 15m.",
        }),
    });
    if (timeout <= 0 || timeout > 2_147_483_647) {
      return yield* new WarehouseEnableInputError({
        message: "--timeout must be positive and no longer than 596h.",
      });
    }
    const ref = yield* resolveProjectTarget({ remote: flags.remote, projectRef: flags.projectRef });
    yield* Effect.annotateCurrentSpan("project.ref", ref);
    return yield* Effect.gen(function* () {
      const selection = {
        mode: "enable" as const,
        targets: [
          Option.isSome(flags.table)
            ? { type: "table" as const, schema: flags.schema, name: flags.table.value }
            : { type: "schema" as const, schema: flags.schema },
        ],
      };
      const preview = yield* api.v2
        .previewWarehouseSetup({ ref, data: { type: "warehouse_setup", attributes: selection } })
        .pipe(Effect.catch(mapError), Effect.withSpan("warehouse.enable.preview"));
      const tables = preview.data.attributes.selected_tables;
      yield* Effect.annotateCurrentSpan("table.count", tables.length);
      const selectedTableNames = tables.map((table) => {
        const schema = sanitizeInlineName(JSON.stringify(table.schema));
        const name = sanitizeInlineName(JSON.stringify(table.name));
        return `  ${schema}.${name}`;
      });
      yield* output.raw(`Selected source tables:\n${selectedTableNames.join("\n")}\n`, "stderr");
      if (Option.isNone(flags.table)) {
        yield* output.raw(
          "Schema selection includes only the eligible tables that exist now.\nTables created later are not replicated automatically; add them to Warehouse replication separately.\n",
          "stderr",
        );
      }
      yield* output.raw("Selected partitioned tables include future partitions.\n", "stderr");
      yield* requireHostedMutationConsent({ action: "Enable Warehouse and start replication" });
      const task = yield* output.task("Enabling Warehouse...");
      const accepted = yield* api.v2
        .enableWarehouse({
          ref,
          data: { type: "warehouse_setup", attributes: { ...selection, confirmed_tables: tables } },
        })
        .pipe(
          Effect.catch(mapError),
          Effect.tapError(() => task.fail()),
          Effect.withSpan("warehouse.enable.apply"),
        );
      yield* task.clear;
      if (!flags.wait) {
        const payload = {
          project_ref: ref,
          accepted: accepted.data.attributes.accepted,
          synchronization_complete: false,
          selected_tables: tables,
        };
        if (output.format !== "text") {
          return yield* output.success("Warehouse setup accepted", payload);
        }
        yield* output.raw(
          "Warehouse setup accepted. Initial synchronization is not yet confirmed.\nRun the same command with --wait to wait for completion.\n",
        );
        return;
      }
      const waiting = yield* output.task("Waiting for initial synchronization...");
      const poll = Effect.gen(function* () {
        const response = yield* api.v2
          .getWarehouseSetup({ ref, inspect_fdw: "false" })
          .pipe(Effect.catch(mapError));
        const status = response.data.attributes;
        const setupStopped = ["error", "disabled", "disabling", "deletion_failed"].includes(
          status.setup_status,
        );
        const hasTableError = status.tables.some((table) => table.state === "error");
        if (setupStopped || hasTableError) {
          return yield* new WarehouseEnableIncompleteError({
            message: `Warehouse setup is ${status.setup_status}; initial synchronization did not complete.`,
            suggestion: "Inspect Warehouse in the dashboard before retrying.",
          });
        }
        const hasSameTableCount = status.tables.length === tables.length;
        const hasSameSelection =
          hasSameTableCount &&
          tables.every((table) =>
            status.tables.some(
              (observed) =>
                observed.id === table.id &&
                observed.schema === table.schema &&
                observed.name === table.name,
            ),
          );
        if (status.tables.length > 0 && !hasSameSelection) {
          return yield* new WarehouseEnableIncompleteError({
            message: "The Warehouse replication selection changed while waiting.",
            suggestion: "Review the current selection before retrying.",
          });
        }
        const pipelineStarted = ["started", "streaming"].includes(status.replication_state);
        const allTablesCopied = status.tables.every(
          (table) =>
            table.replication_state === "copied_table" ||
            table.replication_state === "following_wal",
        );
        const complete =
          status.setup_status === "complete" &&
          status.dns?.status === "ready" &&
          pipelineStarted &&
          hasSameTableCount &&
          allTablesCopied;
        yield* Effect.annotateCurrentSpan("synchronization.complete", complete);
        return { status, complete };
      });
      const result = yield* poll.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result) => result.complete,
        }),
        Effect.timeoutOrElse({
          duration: Duration.millis(timeout),
          orElse: () =>
            Effect.fail(
              new WarehouseEnableTimeoutError({
                message:
                  "Timed out waiting for initial synchronization. Warehouse setup may still be running.",
                suggestion:
                  "Run the same command with --wait to continue waiting, or inspect Warehouse in the dashboard.",
              }),
            ),
        }),
        Effect.tapError(() => waiting.fail()),
        Effect.withSpan("warehouse.enable.wait"),
      );
      yield* waiting.clear;
      if (output.format !== "text") {
        return yield* output.success("Warehouse enabled", {
          project_ref: ref,
          accepted: true,
          synchronization_complete: true,
          ...result.status,
        });
      }
      yield* output.raw(
        `Initial synchronization: ${tables.length}/${tables.length} tables complete.\nReplication: ${sanitizeInlineName(result.status.replication_state)}.\nWarehouse enabled.\n`,
      );
    }).pipe(Effect.ensuring(cache.cache(ref)));
  });
  return yield* run.pipe(Effect.ensuring(telemetry.flush));
});
