import { loadProjectConfig, loadProjectEnvironment, ProjectConfigSchema } from "@supabase/config";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option, Schema } from "effect";

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
import { legacyResolveProjectEnvironmentValues } from "../../shared/legacy-project-environment.ts";
import { legacyValidateWorkdirIsDirectory } from "../../shared/legacy-workdir-validation.ts";
import type { LegacyStatusFlags } from "./status.command.ts";
import {
  LegacyStatusConfigLoadError,
  LegacyStatusDbInspectError,
  LegacyStatusDbNotReadyError,
  LegacyStatusDbNotRunningError,
  LegacyStatusInvalidConfigError,
  LegacyStatusListError,
  LegacyStatusOverrideParseError,
  LegacyStatusWorkdirError,
} from "./status.errors.ts";
import { legacyRenderStatusPretty } from "./status.pretty.ts";
import {
  LEGACY_STATUS_FIELDS,
  legacyGateStatusState,
  legacyResolveStatusLocalState,
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
  const fs = yield* FileSystem.FileSystem;

  yield* Effect.gen(function* () {
    // 0. Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-250`)
    // unconditionally `os.Chdir`s the resolved `--workdir`/`SUPABASE_WORKDIR`
    // in `PersistentPreRunE` (`cmd/root.go:93-105`) — before `status`'s own
    // `PreRunE` (override-name parsing) or `RunE`. A missing or non-directory
    // path fails immediately, so this must win over every later error.
    yield* legacyValidateWorkdirIsDirectory(cliConfig.workdir, fs).pipe(
      Effect.mapError((error) => new LegacyStatusWorkdirError({ message: error.message })),
    );

    // 1. `--override-name KEY=VALUE` parsing — mirroring Go's Cobra wiring,
    // where override validation runs in `PreRunE` (`cmd/status.go:21-27`) and
    // Cobra's execute loop returns as soon as `PreRunE` errors, never calling
    // `RunE` (`spf13/cobra@v1.10.2/command.go:999-1015`). So a malformed
    // `--override-name` entry fails before `status.Run` ever loads config or
    // touches Docker (`internal/status/status.go:101-116`) — it must win over
    // a config-load error or a Docker/DB health-check error, not be masked by
    // either. `overrides` itself is only consumed much later, by
    // `legacyStatusValuesFromState` below.
    const overrides = yield* parseOverrides(flags.overrideName);

    // 2. `status` always needs config, unlike `stop` (status.go:99-103). An
    // ABSENT config.toml is not a hard failure in Go: `flags.LoadConfig` ->
    // `Config.Load` -> `loadFromFile` -> `mergeFileConfig` treats a missing
    // file as a no-op (`os.ErrNotExist` -> nil, pkg/config/config.go:655-656)
    // and proceeds with template defaults (`mergeDefaultValues`,
    // pkg/config/config.go:639-648). Only a MALFORMED file is a hard error.
    // Mirror that by decoding an empty document through the schema for its
    // defaults (matching `packages/config/src/functions-manifest.ts`'s
    // `decodeProjectConfig({})` pattern) instead of failing.
    // `search: false` on both loaders below: `cliConfig.workdir` already IS
    // Go's fully-resolved chdir target (`legacy-cli-config.layer.ts`'s
    // `resolveWorkdir` mirrors `ChangeWorkDir`'s explicit-exact-vs-default-
    // searched resolution, `apps/cli-go/internal/utils/misc.go:231-247`), so
    // letting `@supabase/config`'s `findProjectPaths` climb ancestors again on
    // top of that would let an unrelated ancestor project's config.toml win
    // when `--workdir`/`SUPABASE_WORKDIR` points at a subdirectory with no
    // `supabase/config.toml` of its own — Go never searches past the exact
    // (explicit or defaulted) workdir (`NewPathBuilder`, `pkg/config/utils.go:
    // 43-48`).
    const projectEnv = yield* loadProjectEnvironment({
      cwd: cliConfig.workdir,
      baseEnv: process.env,
      search: false,
      // Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/config.go:1243-1250`)
      // omits `.env.local` from its candidate list whenever
      // `SUPABASE_ENV=test` — a malformed or intentionally non-test
      // `supabase/.env.local` is then invisible to Go and must not fail
      // config loading here either. `legacyResolveProjectEnvironmentValues`
      // below already applies this same gate for the project-root pass (see
      // its `candidateDotenvFilenames`); this mirrors it for the
      // `supabase/`-dir pass `loadProjectEnvironment` itself performs.
      skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStatusConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );

    // `legacyResolveProjectEnvironmentValues` fills the gap between
    // `loadProjectEnvironment` (supabase/.env(.local) + ambient only) and Go's
    // `loadNestedEnv`, which also loads project-root and `SUPABASE_ENV`-selected
    // dotenv files (`pkg/config/config.go:1169-1207`) — see its doc comment for
    // the full precedence chain. Resolved BEFORE `loadProjectConfig` decodes
    // config.toml (not after) because Go's `Config.Load` runs `loadNestedEnv`
    // before `LoadEnvHook` decodes `env(...)` references (`config.go:735-738`);
    // an `env(...)` value sourced only from a project-root/`SUPABASE_ENV`-
    // selected file must already be visible to the decoder, not just to the
    // `SUPABASE_PROJECT_ID`/`SUPABASE_AUTH_*` overrides read further below.
    // A malformed extra dotenv file throws here (see `readDotEnvFile`),
    // matching Go's `loadNestedEnv` propagating `godotenv`'s parse error
    // instead of silently skipping the bad line. `workdir` is passed through so
    // dotenv files under `<workdir>/supabase`/`workdir` are still discovered
    // even when `projectEnv` is `null` (no config.toml there) — Go's own
    // `loadNestedEnv` runs unconditionally, before `config.toml` is ever
    // opened (`pkg/config/config.go:786-793`).
    const projectEnvValues = yield* Effect.try({
      try: () => legacyResolveProjectEnvironmentValues(projectEnv, cliConfig.workdir),
      catch: (cause) =>
        new LegacyStatusConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
    });

    const loaded = yield* loadProjectConfig(cliConfig.workdir, {
      projectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
      search: false,
      // Go's `NewPathBuilder`/`Config.Load` (`pkg/config/utils.go:43-48`) only
      // ever resolves `supabase/config.toml` — it has no concept of a JSON
      // project config file. Without this, a workdir with a stray
      // `config.json` would make `loadProjectConfig` prefer it over
      // `config.toml`, reporting ports/keys for a config Go never reads.
      tomlOnly: true,
      goViperCompat: true,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStatusConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );
    const config = loaded?.config ?? Schema.decodeUnknownSync(ProjectConfigSchema)({});

    // 3. Resolve + VALIDATE config-derived state before any Docker call —
    // matching Go's `flags.LoadConfig` (config load + `Validate`,
    // `internal/utils/flags/config_path.go:12` -> `pkg/config/config.go:882`),
    // which runs entirely before `assertContainerHealthy`/container listing
    // (`internal/status/status.go:101-116`). `legacyResolveStatusLocalState`
    // can throw `LegacyInvalidJwtSecretError` (a short `auth.jwt_secret`),
    // `LegacyInvalidPortEnvOverrideError`/`LegacyInvalidBoolEnvOverrideError`
    // (a malformed `SUPABASE_*_PORT`/`SUPABASE_*_ENABLED` override), or a
    // signing-keys-file read/parse error — all of these must fail here, not
    // be masked by a Docker/DB error when the local stack happens to be
    // unavailable. `hostname` has no Docker dependency either, so it's
    // resolved here rather than later.
    const hostname = legacyGetHostname();
    const localState = yield* Effect.try({
      try: () =>
        legacyResolveStatusLocalState(
          config,
          hostname,
          cliConfig.workdir,
          projectEnvValues,
          loaded?.document,
        ),
      catch: (cause) =>
        new LegacyStatusInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // 4. status has no --project-id flag; resolution is always env → toml →
    // workdir basename, then sanitized to match the singleton Go's
    // `Config.Validate` produces once at config-load time
    // (`pkg/config/config.go:938-944`) — every reader, including the Docker
    // LABEL `start` writes (`internal/utils/docker.go:375`), sees that same
    // sanitized string, so `status` must filter on it too (see
    // `legacyCliProjectFilterValue`'s doc comment).
    const projectId = legacySanitizeProjectId(
      legacyResolveLocalProjectId(
        projectEnvValues["SUPABASE_PROJECT_ID"] ?? process.env["SUPABASE_PROJECT_ID"],
        config.project_id,
        cliConfig.workdir,
      ),
    );
    const dbContainerId = localDbContainerId(projectId);

    // 5. Health check, skipped entirely with --ignore-health-check (status.go:104-108).
    // Go's `assertContainerHealthy` never special-cases "not found" — an absent
    // container fails `ContainerInspect` itself, which surfaces as the generic
    // inspect error (status.go:147-150), not the "not running" branch (which
    // only applies to a present-but-stopped container, status.go:150-151).
    // `legacyInspectContainerState` mirrors that: a missing container is just
    // another non-zero exit, mapped below with the real Docker stderr text.
    if (!flags.ignoreHealthCheck) {
      const state = yield* legacyInspectContainerState(spawner, dbContainerId).pipe(
        Effect.mapError((cause) => new LegacyStatusDbInspectError({ message: cause.message })),
      );
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

    // 6. List running containers, diff against the 13 expected service ids
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

    // 7. Merge health-derived exclusions with the user's --exclude flag.
    const excluded = [...stopped, ...flags.exclude];

    // 8. Apply the exclude-based gating on top of the already-validated
    // `localState` (Go's `toValues()` exclude filtering, `status.go:55-61`).
    // Pure/non-throwing — see `legacyGateStatusState`'s doc comment. Reused
    // for both the real and pretty-mode (empty-override) value maps below,
    // matching this handler's pre-split behavior.
    const containerIds = legacyStatusContainerIds(projectId);
    const state = legacyGateStatusState(localState, containerIds, excluded);
    const { values } = legacyStatusValuesFromState(state, overrides);

    // Go's `PrettyPrint` (`status.go:236-243`) unmarshals a FRESH, empty
    // `EnvSet{}` into a brand-new `CustomName{}` rather than reusing the
    // CLI-supplied, override-populated `names` — `--override-name` only ever
    // affects `printStatus`'s env/json/toml/yaml path, never the pretty table.
    // Remap names from the already-resolved `state` (empty override map) so the
    // rendered table matches Go exactly without leaking `--override-name` into
    // pretty-mode output, and without a second (throwing) state resolution.
    const renderPretty = Effect.fnUntraced(function* () {
      yield* output.raw(
        `${legacyAqua("supabase")} local development setup is running.\n\n`,
        "stderr",
      );
      const pretty = legacyStatusValuesFromState(state, new Map());
      yield* output.raw(legacyRenderStatusPretty(pretty.values, pretty.names));
    });

    // 9. Output branching: Go's -o (env|json|toml|yaml|pretty) is a complete
    // format choice and takes priority over --output-format (root.ts:119-121,
    // matching functions/list's list.handler.ts:115-118) — only an ABSENT -o
    // defers to --output-format for json/stream-json.
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
    if (goFmt === "pretty") {
      yield* renderPretty();
      return;
    }

    // goFmt is undefined — defer to TS --output-format for json/stream-json,
    // otherwise render the grouped rounded-table (Go's `-o pretty` default).
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", values);
      return;
    }

    yield* renderPretty();
  }).pipe(Effect.ensuring(telemetryState.flush));
});
