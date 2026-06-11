import { Effect, Option } from "effect";
import {
  downloadFunctions,
  makeGoProxyDownloadArgs,
} from "../../../../shared/functions/download.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsDownloadFlags } from "./download.command.ts";

export const legacyFunctionsDownload = Effect.fn("legacy.functions.download")(function* (
  flags: LegacyFunctionsDownloadFlags,
) {
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const proxy = yield* LegacyGoProxy;
  let resolvedProjectRef = Option.none<string>();

  yield* downloadFunctions(flags, {
    api,
    projectRoot: cliConfig.workdir,
    resolveProjectRef: (projectRef) =>
      resolver.resolve(projectRef).pipe(
        Effect.tap((ref) =>
          Effect.sync(() => {
            resolvedProjectRef = Option.some(ref);
          }),
        ),
      ),
    proxyDownload: (proxyFlags, projectRef) =>
      proxy.exec(makeGoProxyDownloadArgs(proxyFlags, projectRef)),
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Option.match(resolvedProjectRef, {
          onNone: () => Effect.void,
          onSome: (ref) => linkedProjectCache.cache(ref),
        }),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
