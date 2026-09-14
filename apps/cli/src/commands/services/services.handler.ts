import { Effect, Exit, FileSystem, Option, Path } from "effect";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  PROJECT_REF_PATTERN,
} from "../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { readDbToml } from "../../command-internal/db-config.toml-read.ts";
import { resolveDbImage } from "../../command-internal/db-image.ts";
import { resolveEdgeRuntimeImage } from "../../command-internal/edge-runtime-image.ts";
import { readServiceVersionOverrides } from "../../command-internal/service-version-overrides.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { encodeGoJson } from "../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../command-internal/go-struct-output.encoders.ts";
import {
  fetchLinkedServiceVersions,
  formatServicesWarning,
  listLocalServiceVersions,
  type LocalServiceImageOverrides,
  mergeRemoteServiceVersions,
  renderServicesTable,
  renderServicesWarning,
} from "../../shared/services/services.shared.ts";
import type { ServicesFlags } from "./services.command.ts";
import { ServicesEnvNotSupportedError } from "./services.errors.ts";

/**
 * Struct shape for `imageVersion`: field order is name, local, remote (not
 * alphabetical), and `remote` is always emitted even when empty.
 */
const GO_IMAGE_VERSION = goStruct([
  ["name", goString],
  ["local", goString],
  ["remote", goString],
]);

const GO_SERVICES_LIST = goSlice(GO_IMAGE_VERSION);

const GO_SERVICES_TOML_WRAPPER = goTomlListWrapper("services", GO_IMAGE_VERSION);

export const services = Effect.fn("services")(function* (_flags: ServicesFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const cliSettings = yield* CommandSettings;
  const credentials = yield* CommandCredentials;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
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

    // Warns on a ref-file read error, but treats a NotFound race between the
    // exists() check and this read as simply unlinked (silent, no warning).
    // Only the "failed to load project ref: " prefix is compatibility-bearing.
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
      // A malformed linked ref still warns, but the remote call is skipped:
      // `fetchLinkedServiceVersions` embeds the ref unescaped into the tenant
      // gateway hostname, so proceeding could redirect the service-role key to
      // an attacker-controlled host. Emitted before the config-load warning to
      // preserve output order.
      yield* output.raw(`${INVALID_PROJECT_REF_MESSAGE}\n`, "stderr");
    }

    const tomlValues = yield* readDbToml(
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
        : yield* readServiceVersionOverrides(
            fs,
            path,
            cliSettings.workdir,
            tomlValues.majorVersion,
          );
    const postgresImage =
      tomlValues === null
        ? undefined
        : (yield* resolveDbImage(
            fs,
            path,
            cliSettings.workdir,
            tomlValues.majorVersion,
            Option.getOrUndefined(tomlValues.orioledbVersion),
          )).image;
    const edgeRuntimeImage =
      tomlValues === null
        ? undefined
        : yield* resolveEdgeRuntimeImage(fs, path, cliSettings.workdir, tomlValues.denoVersion);
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

    const goOutput = Option.getOrUndefined(goOutputFlag);

    if (goOutput === "env") {
      return yield* Effect.fail(
        new ServicesEnvNotSupportedError({
          message: "--output env flag is not supported",
        }),
      );
    }

    if (goOutput === "json") {
      yield* output.raw(encodeGoJson(rows));
      return;
    }

    if (goOutput === "yaml") {
      yield* output.raw(encodeGoYaml(rows, GO_SERVICES_LIST));
      return;
    }

    if (goOutput === "toml") {
      yield* output.raw(encodeGoToml({ services: rows }, GO_SERVICES_TOML_WRAPPER));
      return;
    }

    // goOutput is undefined or "pretty" — defer to --output-format for machine
    // output, otherwise render the `--output pretty` table. This keeps
    // `--output pretty --output-format json` emitting JSON.
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
