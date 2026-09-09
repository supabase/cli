import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../../shared/runtime/stdin.layer.ts";
import { identityStitchLayer } from "../../../../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../../../../command-internal/management-api-runtime.layer.ts";
import { telemetryStateLayer } from "../../../../../telemetry/telemetry-state.layer.ts";
import {
  pgDeltaCommandRuntimeLayer,
  pgDeltaDbConfigRuntimeLayer,
} from "../../../shared/pgdelta-engine.layer.ts";

export const dbSchemaDeclarativeGenerateRuntimeLayer = Layer.mergeAll(
  pgDeltaDbConfigRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  identityStitchLayer,
  telemetryStateLayer,
  linkedDbResolverRuntimeLayer(["db", "schema", "declarative", "generate"]).pipe(
    Layer.provide(identityStitchLayer),
  ),
  commandRuntimeLayer(["db", "schema", "declarative", "generate"]),
  stdinLayer,
);
