import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { MachineErrorContext } from "../../shared/output/machine-error-context.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { aqua } from "../../command-internal/colors.ts";
import {
  cliProjectFilterValue,
  serviceContainerIds,
  localDbContainerId,
} from "../../command-internal/docker-ids.ts";
import {
  inspectContainerState,
  listContainersByLabel,
} from "../../command-internal/docker-lifecycle.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../command-internal/go-output.encoders.ts";
import {
  formatLinkedStateBlock,
  linkedStateGoFields,
  linkedStateJsonField,
  resolveLinkedState,
} from "../../command-internal/linked-state.ts";
import { loadLocalProjectContext } from "../../command-internal/local-project-context.ts";
import {
  StatusConfigLoadError,
  StatusDbInspectError,
  StatusDbNotReadyError,
  StatusDbNotRunningError,
  StatusInvalidConfigError,
  StatusListError,
  StatusOverrideParseError,
  StatusWorkdirError,
} from "../../command-internal/status-errors.ts";
import { renderStatusPretty } from "../../command-internal/status-pretty.ts";
import {
  STATUS_FIELDS,
  gateStatusState,
  resolveStatusLocalState,
  statusContainerIds,
  statusValuesFromState,
} from "../../command-internal/status-values.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import type { StatusFlags } from "./status.command.ts";

/**
 * Parses `--override-name api.url=NEXT_PUBLIC_SUPABASE_URL` entries into a `fieldKey -> outputName`
 * map. Each entry must be `KEY=VALUE`; an unknown `KEY` is silently ignored, not an error.
 */
function parseOverrides(
  entries: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string>, StatusOverrideParseError> {
  const knownKeys = new Set(STATUS_FIELDS.map((field) => field.fieldKey));
  const overrides = new Map<string, string>();
  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      return Effect.fail(
        new StatusOverrideParseError({
          message: `invalid override-name entry, expected KEY=VALUE: ${entry}`,
        }),
      );
    }
    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    if (!knownKeys.has(key)) {
      continue;
    }
    overrides.set(key, value);
  }
  return Effect.succeed(overrides);
}

/** The established `"Stopped services:", stopped` slice format. */
function formatGoStringSlice(items: ReadonlyArray<string>): string {
  return `[${items.join(" ")}]`;
}

export const status = Effect.fn("status")(function* (flags: StatusFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;

  // `-o` (env|json|toml|yaml|pretty) is a complete format choice and takes priority over
  // `--output-format` — hoisted so the linked-state print gate below and the final render
  // branching share one computation.
  const goFmt = Option.getOrUndefined(goOutputFlag);

  yield* Effect.gen(function* () {
    // Resolves the current linked project/branch in every output mode (never fails) so agents
    // driving machine-readable output can discover it without a separate `link`/`branches` call.
    // Runs before any daemon/stack work so the printed line stays visible even if status later
    // fails to reach Docker, and inside the telemetry-ensured scope so an interrupted lookup
    // still flushes telemetry state.
    const linkedState = yield* resolveLinkedState();
    if (output.format === "text" && (goFmt === undefined || goFmt === "pretty")) {
      yield* output.raw(formatLinkedStateBlock(linkedState));
    }
    if (output.format === "json" || output.format === "stream-json") {
      // Mirrors the linked-project field onto the shared machine error envelope too
      // (`MachineErrorContext`, read by `output.fail`), not just the success payload below —
      // an agent probing a stopped stack needs this on the failure path too. Read optionally so a
      // runtime that doesn't provide the cell just skips the mirroring.
      const machineErrorContext = yield* Effect.serviceOption(MachineErrorContext);
      if (Option.isSome(machineErrorContext)) {
        yield* machineErrorContext.value.set({
          linked_project: linkedStateJsonField(linkedState),
        });
      }
    }

    // 0. A missing/non-directory `--workdir` must fail before any other validation or Docker work.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new StatusWorkdirError({ message: error.message })),
    );

    // 1. A malformed `--override-name` entry must fail before config load or any Docker work,
    // not be masked by a later config or health-check error. `overrides` is only consumed much
    // later, by `statusValuesFromState`.
    const overrides = yield* parseOverrides(flags.overrideName);

    // 2. An absent config.toml is not a hard failure — only a malformed one is; a missing file
    // proceeds with template defaults. `loadLocalProjectContext` also resolves the sanitized
    // project id used below; see its own doc comment for the full rationale.
    const context = yield* loadLocalProjectContext(
      cliSettings.workdir,
      (message) => new StatusConfigLoadError({ message }),
    );

    // 3. Config validation runs entirely before the health check/container listing below, so a
    // config error (`InvalidJwtSecretError`, a malformed `SUPABASE_*_PORT`/`_ENABLED` override, a
    // signing-keys-file error) fails here rather than being masked by a Docker/DB error.
    const localState = yield* Effect.try({
      try: () =>
        resolveStatusLocalState(
          context.config,
          context.hostname,
          cliSettings.workdir,
          context.projectEnvValues,
          context.loaded?.document,
        ),
      catch: (cause) =>
        new StatusInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // 4. `status` has no --project-id flag: resolution is env → toml → workdir basename, then
    // sanitized to match the same string the Docker label `start` writes (see
    // `cliProjectFilterValue`'s doc comment).
    const projectId = context.projectId;
    const dbContainerId = localDbContainerId(projectId);

    // 5. Skipped entirely with --ignore-health-check. An absent container fails the inspect call
    // itself (a generic inspect error), not the "not running" branch, which only applies to a
    // present-but-stopped container.
    if (!flags.ignoreHealthCheck) {
      const state = yield* inspectContainerState(spawner, dbContainerId).pipe(
        Effect.mapError((cause) => new StatusDbInspectError({ message: cause.message })),
      );
      if (!state.running) {
        return yield* Effect.fail(
          new StatusDbNotRunningError({
            message: `${dbContainerId} container is not running: ${state.status}`,
          }),
        );
      }
      if (state.health !== undefined && state.health !== "healthy") {
        return yield* Effect.fail(
          new StatusDbNotReadyError({
            message: `${dbContainerId} container is not ready: ${state.health}`,
          }),
        );
      }
    }

    // 6. List running containers, diff against the 13 expected service ids,
    // and report any that are stopped.
    const filterValue = cliProjectFilterValue(projectId);
    const runningNames = yield* listContainersByLabel(spawner, {
      projectIdFilter: filterValue,
      all: false,
      format: "names",
    }).pipe(Effect.mapError((cause) => new StatusListError({ message: cause.message })));
    const runningSet = new Set(runningNames);
    const serviceIds = serviceContainerIds(projectId);
    const stopped = serviceIds.filter((id) => !runningSet.has(id));
    if (stopped.length > 0) {
      yield* output.raw(`Stopped services: ${formatGoStringSlice(stopped)}\n`, "stderr");
    }

    // 7. Merge health-derived exclusions with the user's --exclude flag.
    const excluded = [...stopped, ...flags.exclude];

    // 8. Applies exclude-based gating on top of the already-validated `localState`; pure and
    // non-throwing (see `gateStatusState`'s doc comment). Reused for both the real and
    // pretty-mode (empty-override) value maps below.
    const containerIds = statusContainerIds(projectId);
    const state = gateStatusState(localState, containerIds, excluded);
    const { values } = statusValuesFromState(state, overrides);

    // The pretty renderer always uses a fresh, empty override map — `--override-name` only
    // affects the env/json/toml/yaml path, never the pretty table — remapped from the
    // already-resolved `state` so it stays consistent without a second (throwing) resolution.
    const renderPretty = Effect.fnUntraced(function* () {
      yield* output.raw(`${aqua("supabase")} local development setup is running.\n\n`, "stderr");
      const pretty = statusValuesFromState(state, new Map());
      yield* output.raw(renderStatusPretty(pretty.values, pretty.names));
    });

    // 9. `-o` takes priority over `--output-format`; only an absent `-o` defers to
    // `--output-format` for json/stream-json. Every non-pretty branch folds in the linked-state
    // fields resolved above (absent entirely when not linked); the pretty table never sees them.
    // `values` spreads last so an `--override-name`-renamed field always wins a key collision
    // with the linked-state extension, never the other way round.
    const valuesWithLinkedState = { ...linkedStateGoFields(linkedState), ...values };

    if (goFmt === "env") {
      yield* output.raw(encodeEnv(valuesWithLinkedState) + "\n");
      return;
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(valuesWithLinkedState));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml(valuesWithLinkedState) + "\n");
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(valuesWithLinkedState));
      return;
    }
    if (goFmt === "pretty") {
      yield* renderPretty();
      return;
    }

    // goFmt is undefined: defer to --output-format for json/stream-json, otherwise render the
    // grouped rounded-table (the `-o pretty` default).
    if (output.format === "json" || output.format === "stream-json") {
      // `null` when not linked. `values` spreads last so an `--override-name`-renamed field
      // literally named `linked_project` still wins over this extension — same rule as
      // `valuesWithLinkedState` above.
      yield* output.success("", {
        linked_project: linkedStateJsonField(linkedState),
        ...values,
      });
      return;
    }

    yield* renderPretty();
  }).pipe(Effect.ensuring(telemetryState.flush));
});
