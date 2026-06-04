import { styleText } from "node:util";
import { Effect, Exit, FileSystem, Option, Path } from "effect";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyTomlRows,
  fetchLinkedServiceVersions,
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
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.gen(function* () {
    const projectRefPath = path.join(cliConfig.workdir, "supabase", ".temp", "project-ref");
    const accessTokenExit = yield* credentials.getAccessToken.pipe(Effect.exit);
    const accessToken = Exit.isSuccess(accessTokenExit) ? accessTokenExit.value : Option.none();
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
      const lines = warning.split("\n");
      const prefix = output.format === "text" ? styleText("yellow", "WARNING:") : "WARNING:";
      const [first, ...rest] = lines;
      yield* output.raw(`${prefix} ${first}\n${rest.join("\n")}\n`, "stderr");
    }

    const goOutput = Option.getOrUndefined(legacyOutput);

    if (goOutput === undefined && (output.format === "json" || output.format === "stream-json")) {
      yield* output.success("", { services: rows });
      return;
    }

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

    yield* output.raw(renderServicesTable(rows));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
