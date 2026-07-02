import { loadProjectConfig, ProjectConfigSchema } from "@supabase/config";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Option, Schema } from "effect";

import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { legacyAqua } from "../../shared/legacy-colors.ts";
import {
  legacyCliProjectFilterValue,
  legacyResolveLocalProjectId,
  legacySanitizeProjectId,
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
  LegacyStatusInvalidConfigError,
  LegacyStatusListError,
  LegacyStatusOverrideParseError,
} from "./status.errors.ts";
import { legacyRenderStatusPretty } from "./status.pretty.ts";
import {
  LEGACY_STATUS_FIELDS,
  legacyResolveStatusState,
  legacyStatusContainerIds,
  legacyStatusValuesFromState,
} from "./status.values.ts";

/**
 * Parses `--override-name api.url=NEXT_PUBLIC_SUPABASE_URL` entries into a
 * `fieldKey -> outputName` map, mirroring Go's `env.EnvironToEnvSet` +
 * `env.Unmarshal` (`cmd/status.go:21-27`): each entry must be a `KEY=VALUE`
 * pair. `env.EnvironToEnvSet` only validates that shape (`go-env`'s
 * `ErrInvalidEnviron`); the Netflix `go-env` library's `Unmarshal` then walks
 * `CustomName`'s own struct fields and looks up each field's tag in the
 * resulting map — it never checks the map for leftover/unmatched keys, so an
 * entry whose `KEY` isn't one of the 18 known `CustomName` field keys is
 * silently ignored, not an error (verified against `go-env@v0.1.2`'s
 * `env.go`/`transform.go`).
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
      continue;
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
    // 1. `status` always needs config, unlike `stop` (status.go:99-103). An
    // ABSENT config.toml is not a hard failure in Go: `flags.LoadConfig` ->
    // `Config.Load` -> `loadFromFile` -> `mergeFileConfig` treats a missing
    // file as a no-op (`os.ErrNotExist` -> nil, pkg/config/config.go:655-656)
    // and proceeds with template defaults (`mergeDefaultValues`,
    // pkg/config/config.go:639-648). Only a MALFORMED file is a hard error.
    // Mirror that by decoding an empty document through the schema for its
    // defaults (matching `packages/config/src/functions-manifest.ts`'s
    // `decodeProjectConfig({})` pattern) instead of failing.
    const loaded = yield* loadProjectConfig(cliConfig.workdir).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStatusConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );
    const config = loaded?.config ?? Schema.decodeUnknownSync(ProjectConfigSchema)({});

    // 2. status has no --project-id flag; resolution is always env → toml →
    // workdir basename, then sanitized to match the singleton Go's
    // `Config.Validate` produces once at config-load time
    // (`pkg/config/config.go:938-944`) — every reader, including the Docker
    // LABEL `start` writes (`internal/utils/docker.go:375`), sees that same
    // sanitized string, so `status` must filter on it too (see
    // `legacyCliProjectFilterValue`'s doc comment).
    const projectId = legacySanitizeProjectId(
      legacyResolveLocalProjectId(
        process.env["SUPABASE_PROJECT_ID"],
        config.project_id,
        cliConfig.workdir,
      ),
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

    // `legacyResolveStatusState` can throw `LegacyInvalidJwtSecretError` (a short
    // `auth.jwt_secret`) or a signing-keys-file read/parse error — Go's
    // `Config.Validate` rejects both at config-load time, before this command
    // would ever render anything, so they're surfaced here as a hard failure
    // rather than silently falling back to a default/HMAC-signed key. Resolved
    // once and reused for both the real and pretty-mode (empty-override) value
    // maps below, so a configured `signing_keys_path` is read and the anon/
    // service_role JWTs signed only once per invocation, not twice.
    const state = yield* Effect.try({
      try: () =>
        legacyResolveStatusState(config, containerIds, hostname, excluded, cliConfig.workdir),
      catch: (cause) =>
        new LegacyStatusInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const { values } = legacyStatusValuesFromState(state, overrides);

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
    // Remap names from the already-resolved `state` (empty override map) so the
    // rendered table matches Go exactly without leaking `--override-name` into
    // pretty-mode output, and without a second (throwing) state resolution.
    const pretty = legacyStatusValuesFromState(state, new Map());
    yield* output.raw(legacyRenderStatusPretty(pretty.values, pretty.names));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
