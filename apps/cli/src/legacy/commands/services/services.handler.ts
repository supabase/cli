import { Effect, Exit, FileSystem, Option, Path } from "effect";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyTomlRows,
  fetchLinkedServiceVersions,
  formatServicesWarning,
  listLocalServiceVersions,
  mergeRemoteServiceVersions,
  renderServicesTable,
  renderServicesWarning,
} from "../../../shared/services/services.shared.ts";
import type { LegacyServicesFlags } from "./services.command.ts";
import { LegacyServicesEnvNotSupportedError } from "./services.errors.ts";

export const legacyServices = Effect.fn("legacy.services")(function* (_flags: LegacyServicesFlags) {
  const output = yield* Output;
  const legacyOutput = yield* LegacyOutputFlag;
  const cliConfig = yield* LegacyCliConfig;
  const credentials = yield* LegacyCredentials;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const projectRefPath = path.join(cliConfig.workdir, "supabase", ".temp", "project-ref");
  const linkedProjectRef = yield* Effect.gen(function* () {
    if (Option.isSome(cliConfig.projectId)) {
      return cliConfig.projectId;
    }

    const exists = yield* fs.exists(projectRefPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<string>();
    }

    const content = yield* fs.readFileString(projectRefPath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });

  // Mirror Go's PersistentPostRun (`apps/cli-go/cmd/root.go:176`): when a project
  // ref is resolved, refresh the linked-project cache on success and failure so
  // PostHog org/project groups stay attached. Persist the telemetry state too.
  const cacheLinkedProject = Option.match(linkedProjectRef, {
    onNone: () => Effect.void,
    onSome: (ref) => linkedProjectCache.cache(ref),
  });

  yield* Effect.gen(function* () {
    const accessTokenExit = yield* credentials.getAccessToken.pipe(Effect.exit);
    const accessToken = Exit.isSuccess(accessTokenExit) ? accessTokenExit.value : Option.none();

    let rows = listLocalServiceVersions();
    if (Option.isSome(linkedProjectRef) && Option.isSome(accessToken)) {
      const remote = yield* fetchLinkedServiceVersions({
        apiUrl: cliConfig.apiUrl,
        projectHost: cliConfig.projectHost,
        projectRef: linkedProjectRef.value,
        accessToken: accessToken.value,
        userAgent: cliConfig.userAgent,
      });
      rows = mergeRemoteServiceVersions(remote);
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
      yield* output.raw(encodeYaml(rows));
      return;
    }

    if (goOutput === "toml") {
      yield* output.raw(encodeToml(encodeLegacyTomlRows(rows)));
      return;
    }

    // goOutput is undefined or "pretty" — defer to the TS --output-format flag for
    // machine output, otherwise render the Go `--output pretty` table. Guarding the
    // table behind this (rather than treating "pretty" as force-table) keeps
    // `--output pretty --output-format json` emitting JSON, per CLI-1546.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { services: rows });
      return;
    }

    yield* output.raw(renderServicesTable(rows));
  }).pipe(Effect.ensuring(cacheLinkedProject), Effect.ensuring(telemetryState.flush));
});
