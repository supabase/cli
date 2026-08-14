import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../../../shared/runtime/stdin.layer.ts";
import { legacyIdentityStitchLayer } from "../../../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyTelemetryStateLayer } from "../../../../../telemetry/legacy-telemetry-state.layer.ts";
import {
  legacyPgDeltaCommandRuntimeLayer,
  legacyPgDeltaDbConfigRuntimeLayer,
} from "../../../shared/legacy-pgdelta-engine.layer.ts";

export const legacyDbSchemaDeclarativeSyncRuntimeLayer = Layer.mergeAll(
  legacyPgDeltaDbConfigRuntimeLayer,
  legacyPgDeltaCommandRuntimeLayer,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  legacyLinkedDbResolverRuntimeLayer(["db", "schema", "declarative", "sync"]).pipe(
    Layer.provide(legacyIdentityStitchLayer),
  ),
  commandRuntimeLayer(["db", "schema", "declarative", "sync"]),
  stdinLayer,
);
