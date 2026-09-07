import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { legacyIdentityStitchLayer } from "../../../command-internal/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../../command-internal/legacy-management-api-runtime.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import {
  legacyPgDeltaCommandRuntimeLayer,
  legacyPgDeltaDbConfigRuntimeLayer,
} from "../shared/legacy-pgdelta-engine.layer.ts";

export const legacyDbSchemaPullRuntimeLayer = (command: ReadonlyArray<string>) =>
  Layer.mergeAll(
    legacyPgDeltaDbConfigRuntimeLayer,
    legacyPgDeltaCommandRuntimeLayer,
    legacyIdentityStitchLayer,
    legacyTelemetryStateLayer,
    legacyLinkedDbResolverRuntimeLayer(command).pipe(Layer.provide(legacyIdentityStitchLayer)),
    commandRuntimeLayer(command),
    stdinLayer,
  );

export const legacyDbPullRuntimeLayer = legacyDbSchemaPullRuntimeLayer(["db", "pull"]);
