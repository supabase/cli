import { Effect, Exit, FileSystem, Option, Path } from "effect";
import { LegacyCliSettings } from "../../config/legacy-cli-settings.service.ts";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  PROJECT_REF_PATTERN,
} from "../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyReadDbToml } from "../../shared/legacy-db-config.toml-read.ts";
import { legacyResolveDbImage } from "../../shared/legacy-db-image.ts";
import { legacyResolveEdgeRuntimeImage } from "../../shared/legacy-edge-runtime-image.ts";
import { legacyReadServiceVersionOverrides } from "../../shared/legacy-service-version-overrides.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
  legacyGoTomlListWrapper,
} from "../../shared/legacy-go-struct-output.encoders.ts";
import {
  fetchLinkedServiceVersions,
  formatServicesWarning,
  listLocalServiceVersions,
  type LocalServiceImageOverrides,
  mergeRemoteServiceVersions,
  renderServicesTable,
  renderServicesWarning,
} from "../../../shared/services/services.shared.ts";
import type { LegacyServicesFlags } from "./services.command.ts";
import { LegacyServicesEnvNotSupportedError } from "./services.errors.ts";

/**
 * Type shape for the hand-written `imageVersion` struct — declaration order
 * is Name, Local, Remote (not alphabetical), and `Remote` is always emitted
 * even when empty (CLI-1975).
 */
const LEGACY_GO_IMAGE_VERSION = legacyGoStruct([
  ["name", legacyGoString],
  ["local", legacyGoString],
  ["remote", legacyGoString],
]);

const LEGACY_GO_SERVICES_LIST = legacyGoSlice(LEGACY_GO_IMAGE_VERSION);

const LEGACY_GO_SERVICES_TOML_WRAPPER = legacyGoTomlListWrapper(
  "services",
  LEGACY_GO_IMAGE_VERSION,
);

export const legacyServices = Effect.fn("legacy.services")(function* (_flags: LegacyServicesFlags) {
  const output = yield* Output;
  const legacyOutput = yield* LegacyOutputFlag;
  const cliSettings = yield* LegacyCliSettings;
  const credentials = yield* LegacyCredentials;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const projectRefPath = path.join(cliSettings.workdir, "supabase", ".temp", "project-ref");
  const linkedProjectRef = yield* Effect.gen(function* () {
    if (Option.isSome(cliSettings.projectId)) {
      return cliSettings.projectId;
    }

    const exists = yield* fs.exists(projectRefPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<string>();
    }

    // Warns on a ref-file READ error (as opposed to the file simply
    // not existing) and keeps going as unlinked (`fmt.Fprintln(os.Stderr, err)`
    // with `LoadProjectRef`'s `failed to load project ref: %w`,
    // `project_ref.go:71-72`). A NotFound between the exists() check above and
    // this read (TOCTOU) maps to the `os.ErrNotExist` → `ErrNotLinked` branch:
    // silent, no warning. The warning's error suffix is Effect's description,
    // not the reference implementation's `*PathError` text — the prefix is
    // the compatibility-bearing part.
    const content = yield* fs
      .readFileString(projectRefPath)
      .pipe(
        Effect.catch((cause) =>
          cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
            ? Effect.succeed("")
            : output
                .raw(`failed to load project ref: ${String(cause)}\n`, "stderr")
                .pipe(Effect.as("")),
        ),
      );
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });

  // When a project ref is resolved, refresh the linked-project cache on
  // success and failure so PostHog org/project groups stay attached. Persist
  // the telemetry state too.
  const cacheLinkedProject = Option.match(linkedProjectRef, {
    onNone: () => Effect.void,
    onSome: (ref) => linkedProjectCache.cache(ref),
  });

  yield* Effect.gen(function* () {
    const accessTokenExit = yield* credentials.getAccessToken.pipe(Effect.exit);
    const accessToken = Exit.isSuccess(accessTokenExit) ? accessTokenExit.value : Option.none();

    const validLinkedRef = Option.filter(linkedProjectRef, (ref) => PROJECT_REF_PATTERN.test(ref));
    if (Option.isSome(linkedProjectRef) && Option.isNone(validLinkedRef)) {
      // `flags.LoadProjectRef` (project_ref.go:54-76) validates the ref but
      // the reference `Run` only warns on the error and keeps going, still
      // calling `listRemoteImages` with the malformed ref (services.go:61-62).
      // TS matches the warning but deliberately skips the remote call instead of
      // reproducing it: the ref is embedded unescaped into the tenant gateway
      // hostname in `fetchLinkedServiceVersions`, so proceeding would let a
      // malformed ref redirect the service-role key to an attacker-controlled host.
      // Emitted before the config-load warning below to match the order these
      // are printed in (services.go:18-24).
      yield* output.raw(`${INVALID_PROJECT_REF_MESSAGE}\n`, "stderr");
    }

    const tomlValues = yield* legacyReadDbToml(
      fs,
      path,
      cliSettings.workdir,
      Option.getOrUndefined(linkedProjectRef),
    ).pipe(
      Effect.catch((error) =>
        output.raw(`${formatConfigLoadError(error)}\n`, "stderr").pipe(Effect.as(null)),
      ),
    );
    const serviceVersions =
      tomlValues === null
        ? {}
        : yield* legacyReadServiceVersionOverrides(
            fs,
            path,
            cliSettings.workdir,
            tomlValues.majorVersion,
          );
    const postgresImage =
      tomlValues === null
        ? undefined
        : (yield* legacyResolveDbImage(
            fs,
            path,
            cliSettings.workdir,
            tomlValues.majorVersion,
            Option.getOrUndefined(tomlValues.orioledbVersion),
          )).image;
    const edgeRuntimeImage =
      tomlValues === null
        ? undefined
        : yield* legacyResolveEdgeRuntimeImage(
            fs,
            path,
            cliSettings.workdir,
            tomlValues.denoVersion,
          );
    const imageOverrides: LocalServiceImageOverrides = {};
    if (postgresImage !== undefined) {
      imageOverrides.postgres = postgresImage;
    }
    if (edgeRuntimeImage !== undefined) {
      imageOverrides["edge-runtime"] = edgeRuntimeImage;
    }
    const localImageOptions = {
      imageOverrides,
      normalizeVersionTags: false,
      serviceVersions,
      slimCurrentPinOnly: true,
    };

    let rows = listLocalServiceVersions(localImageOptions);
    if (Option.isSome(validLinkedRef) && Option.isSome(accessToken)) {
      const remote = yield* fetchLinkedServiceVersions({
        apiUrl: cliSettings.apiUrl,
        projectHost: cliSettings.projectHost,
        projectRef: validLinkedRef.value,
        accessToken: accessToken.value,
        userAgent: cliSettings.userAgent,
      });
      rows = mergeRemoteServiceVersions(remote, localImageOptions);
    }

    const warning = renderServicesWarning(rows);
    if (warning !== undefined) {
      yield* output.raw(formatServicesWarning(warning, output.format === "text"), "stderr");
    }

    const goOutput = Option.getOrUndefined(legacyOutput);

    if (goOutput === "env") {
      return yield* Effect.fail(
        new LegacyServicesEnvNotSupportedError({
          message: "--output env flag is not supported",
        }),
      );
    }

    if (goOutput === "json") {
      yield* output.raw(encodeGoJson(rows));
      return;
    }

    if (goOutput === "yaml") {
      yield* output.raw(encodeLegacyGoYaml(rows, LEGACY_GO_SERVICES_LIST));
      return;
    }

    if (goOutput === "toml") {
      yield* output.raw(encodeLegacyGoToml({ services: rows }, LEGACY_GO_SERVICES_TOML_WRAPPER));
      return;
    }

    // goOutput is undefined or "pretty" — defer to the TS --output-format flag for
    // machine output, otherwise render the `--output pretty` table. Guarding the
    // table behind this (rather than treating "pretty" as force-table) keeps
    // `--output pretty --output-format json` emitting JSON, per CLI-1546.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { services: rows });
      return;
    }

    yield* output.raw(renderServicesTable(rows));
  }).pipe(Effect.ensuring(cacheLinkedProject), Effect.ensuring(telemetryState.flush));
});

function formatConfigLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
