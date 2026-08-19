import { Effect, Layer, Option } from "effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { ProjectContext } from "../../next/config/project-context.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  LegacyDebugLogger,
  type LegacyDebugLoggerShape,
} from "../shared/legacy-debug-logger.service.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import { cliConfigFromLegacyProfile } from "./legacy-next-cli-config.ts";

const silentDebugLogger: LegacyDebugLoggerShape = {
  debug: () => Effect.void,
  http: () => Effect.void,
};

/**
 * Next `CliConfig` for any legacy-hosted command that reuses next services.
 *
 * `--profile` is a stable global and is already resolved into `LegacyCliConfig`.
 * Commands must not rebuild hosts from env-only next config.
 */
export const legacyNextCliConfigLayer = Layer.effect(
  CliConfig,
  Effect.gen(function* () {
    const legacy = yield* LegacyCliConfig;
    const runtimeInfo = yield* RuntimeInfo;
    const projectContext = yield* Effect.serviceOption(ProjectContext);
    const debugLogger = Option.getOrElse(
      yield* Effect.serviceOption(LegacyDebugLogger),
      () => silentDebugLogger,
    );
    const env = Option.match(projectContext, {
      onNone: () => process.env,
      onSome: (context) =>
        Option.match(context.projectEnv, {
          onNone: () => process.env,
          onSome: (projectEnv) => projectEnv.values,
        }),
    });
    yield* debugLogger.debug(`Using profile: ${legacy.profile} (${legacy.projectHost})`);
    return CliConfig.of(
      cliConfigFromLegacyProfile({
        apiUrl: legacy.apiUrl,
        dashboardUrl: legacy.dashboardUrl,
        projectHost: legacy.projectHost,
        accessToken: legacy.accessToken,
        homeDir: runtimeInfo.homeDir,
        env,
      }),
    );
  }),
);
