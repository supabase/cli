import { Effect, FileSystem, Option, Path } from "effect";
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
import { currentStackBackend } from "../../command-internal/stack-backend.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { encodeSortedJson } from "../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTomlListWrapper,
} from "../../command-internal/struct-output.encoders.ts";
import {
  fetchLinkedServiceVersions,
  formatServicesWarning,
  listLocalServiceVersions,
  type LocalServiceImageOverrides,
  mergeRemoteServiceVersions,
  renderServicesTable,
  renderServicesWarning,
  type ServiceVersionRow,
} from "../../shared/services/services.shared.ts";
import { slimImagesEnabled } from "../../shared/services/slim-images.ts";
import type { ServicesFlags } from "./services.command.ts";
import { ServicesEnvNotSupportedError } from "./services.errors.ts";
import { stackServiceVersions } from "./services-local-stack.ts";

/**
 * Struct shape for `imageVersion`: field order is name, local, remote (not
 * alphabetical), and `remote` is always emitted even when empty.
 */
const IMAGE_VERSION_SHAPE = shapeStruct([
  ["name", shapeString],
  ["local", shapeString],
  ["remote", shapeString],
]);

const SERVICES_LIST_SHAPE = shapeSlice(IMAGE_VERSION_SHAPE);

const SERVICES_TOML_WRAPPER_SHAPE = shapeTomlListWrapper("services", IMAGE_VERSION_SHAPE);

export const services = Effect.fn("services")(function* (_flags: ServicesFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
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
    const accessToken = yield* credentials.getAccessToken.pipe(
      Effect.catchTag("InvalidAccessTokenError", () => Effect.succeed(Option.none())),
    );

    const validLinkedRef = Option.filter(linkedProjectRef, (ref) => PROJECT_REF_PATTERN.test(ref));
    const backend = yield* currentStackBackend;
    yield* Effect.annotateCurrentSpan({
      "stack.backend": backend.kind,
      "project.linked": Option.isSome(validLinkedRef),
    });
    if (Option.isSome(linkedProjectRef) && Option.isNone(validLinkedRef)) {
      // A malformed linked ref still warns, but the remote call is skipped:
      // `fetchLinkedServiceVersions` embeds the ref unescaped into the tenant
      // gateway hostname, so proceeding could redirect the service-role key to
      // an attacker-controlled host. Emitted before the config-load warning to
      // preserve output order.
      yield* output.raw(`${INVALID_PROJECT_REF_MESSAGE}\n`, "stderr");
    }

    let rows: ReadonlyArray<ServiceVersionRow>;
    if (backend.kind === "stack") {
      const remote =
        Option.isSome(validLinkedRef) && Option.isSome(accessToken)
          ? yield* fetchLinkedServiceVersions({
              apiUrl: cliSettings.apiUrl,
              projectHost: cliSettings.projectHost,
              projectRef: validLinkedRef.value,
              accessToken: accessToken.value,
              userAgent: cliSettings.userAgent,
            })
          : {};
      const result = yield* stackServiceVersions(cliSettings.workdir, remote);
      if (result.configError !== undefined) {
        yield* output.raw(
          `${result.configError}; using default stack catalog versions\n`,
          "stderr",
        );
      }
      rows = result.rows;
    } else {
      const tomlValues = yield* readDbToml(
        fs,
        path,
        cliSettings.workdir,
        Option.getOrUndefined(linkedProjectRef),
      ).pipe(
        Effect.withSpan("services.readConfig"),
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
        slim: yield* slimImagesEnabled,
        imageOverrides,
        normalizeVersionTags: false,
        serviceVersions,
        slimCurrentPinOnly: true,
      };

      rows = listLocalServiceVersions(localImageOptions);
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
    }

    yield* Effect.annotateCurrentSpan({ "service.count": rows.length });

    const warning = renderServicesWarning(
      rows,
      backend.kind === "stack"
        ? {
            heading: "The CLI stack catalog versions differ from your linked project:",
            recommendation:
              "These versions come from the CLI stack catalog and cannot be changed with supabase link.",
          }
        : {},
    );
    if (warning !== undefined) {
      yield* output.raw(formatServicesWarning(warning, output.format === "text"), "stderr");
    }

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    if (outputFlagFormat === "env") {
      return yield* new ServicesEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }

    if (outputFlagFormat === "json") {
      yield* output.raw(encodeSortedJson(rows));
      return;
    }

    if (outputFlagFormat === "yaml") {
      yield* output.raw(encodeStructYaml(rows, SERVICES_LIST_SHAPE));
      return;
    }

    if (outputFlagFormat === "toml") {
      yield* output.raw(encodeStructToml({ services: rows }, SERVICES_TOML_WRAPPER_SHAPE));
      return;
    }

    // outputFlagFormat is undefined or "pretty" — defer to --output-format for machine
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
