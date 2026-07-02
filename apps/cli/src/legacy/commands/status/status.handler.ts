import { loadProjectConfig } from "@supabase/config";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Option } from "effect";

import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { legacyAqua } from "../../shared/legacy-colors.ts";
import {
  legacyCliProjectFilterValue,
  legacyResolveLocalProjectId,
  legacyServiceContainerIds,
  localDbContainerId,
} from "../../shared/legacy-docker-ids.ts";
import {
  legacyInspectContainerState,
  legacyListContainersByLabel,
} from "../../shared/legacy-docker-lifecycle.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../shared/legacy-go-output.encoders.ts";
import { legacyGetHostname } from "../../shared/legacy-hostname.ts";
import type { LegacyStatusFlags } from "./status.command.ts";
import {
  LegacyStatusConfigLoadError,
  LegacyStatusDbInspectError,
  LegacyStatusDbNotReadyError,
  LegacyStatusDbNotRunningError,
  LegacyStatusListError,
  LegacyStatusOverrideParseError,
} from "./status.errors.ts";
import { legacyRenderStatusPretty } from "./status.pretty.ts";
import {
  LEGACY_STATUS_FIELDS,
  legacyStatusContainerIds,
  legacyStatusValues,
} from "./status.values.ts";

/**
 * Parses `--override-name api.url=NEXT_PUBLIC_SUPABASE_URL` entries into a
 * `fieldKey -> outputName` map, mirroring Go's `env.EnvironToEnvSet` +
 * `env.Unmarshal` (`cmd/status.go:21-27`): each entry must be a `KEY=VALUE`
 * pair whose `KEY` matches one of the 18 known `CustomName` field keys.
 */
function parseOverrides(
  entries: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string>, LegacyStatusOverrideParseError> {
  const knownKeys = new Set(LEGACY_STATUS_FIELDS.map((field) => field.fieldKey));
  const overrides = new Map<string, string>();
  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      return Effect.fail(
        new LegacyStatusOverrideParseError({
          message: `invalid override-name entry, expected KEY=VALUE: ${entry}`,
        }),
      );
    }
    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    if (!knownKeys.has(key)) {
      return Effect.fail(
        new LegacyStatusOverrideParseError({
          message: `unknown override-name key: ${key}`,
        }),
      );
    }
    overrides.set(key, value);
  }
  return Effect.succeed(overrides);
}

/** Go's `fmt.Fprintln(os.Stderr, "Stopped services:", stopped)` slice format. */
function formatGoStringSlice(items: ReadonlyArray<string>): string {
  return `[${items.join(" ")}]`;
}

export const legacyStatus = Effect.fn("legacy.status")(function* (flags: LegacyStatusFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* Effect.gen(function* () {
    // 1. `status` always needs config, unlike `stop` (status.go:99-103).
    const loaded = yield* loadProjectConfig(cliConfig.workdir).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStatusConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );
    if (loaded === null) {
      return yield* Effect.fail(
        new LegacyStatusConfigLoadError({
          message: "failed to read config: supabase/config.toml not found",
        }),
      );
    }
    const config = loaded.config;

    // 2. status has no --project-id flag; resolution is always env → toml → workdir basename.
    const projectId = legacyResolveLocalProjectId(
      process.env["SUPABASE_PROJECT_ID"],
      config.project_id,
      cliConfig.workdir,
    );
    const dbContainerId = localDbContainerId(projectId);

    // 3. Health check, skipped entirely with --ignore-health-check (status.go:104-108).
    // Go's `assertContainerHealthy` never special-cases "not found" — an absent
    // container fails `ContainerInspect` itself, which surfaces as the generic
    // inspect error (status.go:147-150), not the "not running" branch (which
    // only applies to a present-but-stopped container, status.go:150-151).
    if (!flags.ignoreHealthCheck) {
      const state = yield* legacyInspectContainerState(spawner, dbContainerId).pipe(
        Effect.mapError((cause) => new LegacyStatusDbInspectError({ message: cause.message })),
      );
      if (state === "absent") {
        return yield* Effect.fail(
          new LegacyStatusDbInspectError({
            message: "failed to inspect container health: no such container",
          }),
        );
      }
      if (!state.running) {
        return yield* Effect.fail(
          new LegacyStatusDbNotRunningError({
            message: `${dbContainerId} container is not running: ${state.status}`,
          }),
        );
      }
      if (state.health !== undefined && state.health !== "healthy") {
        return yield* Effect.fail(
          new LegacyStatusDbNotReadyError({
            message: `${dbContainerId} container is not ready: ${state.health}`,
          }),
        );
      }
    }

    // 4. List running containers, diff against the 13 expected service ids
    // (status.go:125-145), and report any that are stopped.
    const filterValue = legacyCliProjectFilterValue(projectId);
    const runningNames = yield* legacyListContainersByLabel(spawner, {
      projectIdFilter: filterValue,
      all: false,
      format: "names",
    }).pipe(Effect.mapError((cause) => new LegacyStatusListError({ message: cause.message })));
    const runningSet = new Set(runningNames);
    const serviceIds = legacyServiceContainerIds(projectId);
    const stopped = serviceIds.filter((id) => !runningSet.has(id));
    if (stopped.length > 0) {
      yield* output.raw(`Stopped services: ${formatGoStringSlice(stopped)}\n`, "stderr");
    }

    // 5. Merge health-derived exclusions with the user's --exclude flag.
    const excluded = [...stopped, ...flags.exclude];

    // 6. Build the value map (Go's toValues()).
    const containerIds = legacyStatusContainerIds(projectId);
    const hostname = legacyGetHostname();

    // 7. --override-name KEY=VALUE parsing.
    const overrides = yield* parseOverrides(flags.overrideName);

    // `names` is intentionally unused here: the pretty-mode branch below
    // recomputes with an empty override map (matching Go), and every other
    // branch only needs `values`.
    const { values } = legacyStatusValues(config, containerIds, hostname, excluded, overrides);

    // 8. Output branching: Go's -o (env|json|toml|yaml) takes priority over
    // --output-format; -o pretty/unset falls through to text/json/stream-json.
    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      yield* output.raw(encodeEnv(values) + "\n");
      return;
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(values));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml(values) + "\n");
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(values));
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for json/stream-json,
    // otherwise render the grouped rounded-table (Go's `-o pretty` default).
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", values);
      return;
    }

    yield* output.raw(
      `${legacyAqua("supabase")} local development setup is running.\n\n`,
      "stderr",
    );
    // Go's `PrettyPrint` (`status.go:236-243`) unmarshals a FRESH, empty
    // `EnvSet{}` into a brand-new `CustomName{}` rather than reusing the
    // CLI-supplied, override-populated `names` — `--override-name` only ever
    // affects `printStatus`'s env/json/toml/yaml path, never the pretty table.
    // Recompute with an empty override map so the rendered table matches Go
    // exactly instead of leaking `--override-name` into pretty-mode output.
    const pretty = legacyStatusValues(config, containerIds, hostname, excluded, new Map());
    yield* output.raw(legacyRenderStatusPretty(pretty.values, pretty.names));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
