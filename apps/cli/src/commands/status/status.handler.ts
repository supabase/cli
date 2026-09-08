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
 * Parses `--override-name api.url=NEXT_PUBLIC_SUPABASE_URL` entries into a
 * `fieldKey -> outputName` map: each entry must be a `KEY=VALUE`
 * pair, validated only for that shape. Unmatched/unknown keys are walked
 * against the known field keys and looked up — an
 * entry whose `KEY` isn't one of the 18 known field keys is
 * silently ignored, not an error.
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

  // Go's `-o` (env|json|toml|yaml|pretty) is a complete format choice and
  // takes priority over `--output-format` — hoisted so both the linked-state
  // print gate below and the render branching at the end of this handler
  // share one computation.
  const goFmt = Option.getOrUndefined(goOutputFlag);

  yield* Effect.gen(function* () {
    // TS-only QoL (CLI-2167 follow-up, no Go counterpart): resolve the current
    // linked project/branch in EVERY output mode — never fails, and machine
    // formats fold the result into their own payload below — so agents driving
    // `status` machine-readable output can discover which project/branch
    // they're on without a separate `link`/`branches` call. Resolved before any
    // daemon/stack work begins so, in human text mode, the printed line below
    // is visible even when status subsequently fails to connect to Docker.
    // Lives INSIDE the telemetry-ensured scope: an interruption during the
    // (bounded) lookup must still flush telemetry state (PR #6168 review).
    const linkedState = yield* resolveLinkedState();
    if (output.format === "text" && (goFmt === undefined || goFmt === "pretty")) {
      yield* output.raw(formatLinkedStateBlock(linkedState));
    }
    if (output.format === "json" || output.format === "stream-json") {
      // TS-only QoL (CLI-2167 follow-up): the agent-discovery use case for this
      // field matters MOST when status fails to reach the daemon/stack — a
      // stopped stack is the common state an agent probes in — so mirror it
      // onto the shared machine error envelope too (`MachineErrorContext`,
      // read by `output.fail`), not just the success payload below. Harmless
      // on the success path, since `output.success` never reads this cell.
      // Read optionally (adds no R requirement) so this command's runtime
      // choosing not to provide the cell just skips the mirroring, matching
      // `output.fail`'s own optional read on the other end.
      const machineErrorContext = yield* Effect.serviceOption(MachineErrorContext);
      if (Option.isSome(machineErrorContext)) {
        yield* machineErrorContext.value.set({
          linked_project: linkedStateJsonField(linkedState),
        });
      }
    }

    // 0. The resolved `--workdir`/`SUPABASE_WORKDIR` is `chdir`'d into
    // unconditionally — before `status`'s own
    // override-name parsing or handler body. A missing or non-directory
    // path fails immediately, so this must win over every later error.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new StatusWorkdirError({ message: error.message })),
    );

    // 1. `--override-name KEY=VALUE` parsing runs before config load or any
    // Docker work. So a malformed
    // `--override-name` entry fails before the handler ever loads config or
    // touches Docker — it must win over
    // a config-load error or a Docker/DB health-check error, not be masked by
    // either. `overrides` itself is only consumed much later, by
    // `statusValuesFromState` below.
    const overrides = yield* parseOverrides(flags.overrideName);

    // 2. `status` always needs config, unlike `stop`. An
    // ABSENT config.toml is not a hard failure: config loading treats a missing
    // file as a no-op and proceeds with template defaults. Only a MALFORMED
    // file is a hard error.
    // `loadLocalProjectContext` mirrors that (decoding an empty document
    // through the schema for its defaults) and also resolves the sanitized,
    // config/env-derived project id used below — see its own doc comment for
    // the full rationale (including why workdir validation stays out
    // of it and is instead handled by step 0 above).
    const context = yield* loadLocalProjectContext(
      cliSettings.workdir,
      (message) => new StatusConfigLoadError({ message }),
    );

    // 3. Resolve + VALIDATE config-derived state before any Docker call —
    // config load + validation run entirely before the health check/container
    // listing below. `resolveStatusLocalState`
    // can throw `InvalidJwtSecretError` (a short `auth.jwt_secret`),
    // `InvalidPortEnvOverrideError`/`InvalidBoolEnvOverrideError`
    // (a malformed `SUPABASE_*_PORT`/`SUPABASE_*_ENABLED` override), or a
    // signing-keys-file read/parse error — all of these must fail here, not
    // be masked by a Docker/DB error when the local stack happens to be
    // unavailable.
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

    // 4. status has no --project-id flag; resolution is always env → toml →
    // workdir basename, then sanitized to match the singleton config
    // validation produces once at config-load time — every reader, including
    // the Docker LABEL `start` writes, sees that same
    // sanitized string, so `status` must filter on it too (see
    // `cliProjectFilterValue`'s doc comment).
    const projectId = context.projectId;
    const dbContainerId = localDbContainerId(projectId);

    // 5. Health check, skipped entirely with --ignore-health-check.
    // The health check never special-cases "not found" — an absent
    // container fails the inspect call itself, which surfaces as the generic
    // inspect error, not the "not running" branch (which
    // only applies to a present-but-stopped container).
    // `inspectContainerState` mirrors that: a missing container is just
    // another non-zero exit, mapped below with the real Docker stderr text.
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

    // 8. Apply the exclude-based gating on top of the already-validated
    // `localState`.
    // Pure/non-throwing — see `gateStatusState`'s doc comment. Reused
    // for both the real and pretty-mode (empty-override) value maps below,
    // matching this handler's pre-split behavior.
    const containerIds = statusContainerIds(projectId);
    const state = gateStatusState(localState, containerIds, excluded);
    const { values } = statusValuesFromState(state, overrides);

    // The pretty renderer always uses a FRESH, empty override map
    // rather than reusing the CLI-supplied, override-populated `names` —
    // `--override-name` only ever affects the env/json/toml/yaml path, never
    // the pretty table.
    // Remap names from the already-resolved `state` (empty override map) so the
    // rendered table stays consistent without leaking `--override-name` into
    // pretty-mode output, and without a second (throwing) state resolution.
    const renderPretty = Effect.fnUntraced(function* () {
      yield* output.raw(`${aqua("supabase")} local development setup is running.\n\n`, "stderr");
      const pretty = statusValuesFromState(state, new Map());
      yield* output.raw(renderStatusPretty(pretty.values, pretty.names));
    });

    // 9. Output branching (goFmt hoisted above): Go's -o (env|json|toml|yaml|pretty)
    // is a complete format choice and takes priority over --output-format
    // (root.ts:119-121, matching functions/list's list.handler.ts:115-118) —
    // only an ABSENT -o defers to --output-format for json/stream-json.
    //
    // Every non-pretty branch below folds in the linked-state fields resolved
    // above (TS-only QoL, CLI-2167 follow-up) — absent entirely when not linked
    // (no `linked: false` noise in these machine formats). The pretty table
    // never sees them; it reads its own separately-resolved `pretty.values` by
    // known name only.
    //
    // `values` spreads LAST so its own keys always win a collision (PR #6168
    // review): `--override-name` lets a user rename any of the 18 known
    // fields to an arbitrary output key — `--override-name api.url=linked_project_ref`
    // would otherwise silently overwrite our additive field with the API URL,
    // or vice versa depending on spread order. The existing/overridden payload
    // always takes priority over this extension, never the other way round.
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

    // goFmt is undefined — defer to TS --output-format for json/stream-json,
    // otherwise render the grouped rounded-table (the `-o pretty` default).
    if (output.format === "json" || output.format === "stream-json") {
      // `null` when not linked (TS-only QoL, CLI-2167 follow-up). `values`
      // spreads LAST so an `--override-name`-renamed field named literally
      // `linked_project` always wins over this extension (PR #6168 review) —
      // same existing-payload-always-wins rule as `valuesWithLinkedState` above.
      yield* output.success("", {
        linked_project: linkedStateJsonField(linkedState),
        ...values,
      });
      return;
    }

    yield* renderPretty();
  }).pipe(Effect.ensuring(telemetryState.flush));
});
