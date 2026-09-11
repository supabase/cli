import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../../shared/runtime/stdin.layer.ts";
import { machineErrorContextLayer } from "../../../../../shared/output/machine-error-context.layer.ts";
import { identityStitchLayer } from "../../../../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../../../../command-internal/management-api-runtime.layer.ts";
import { telemetryStateLayer } from "../../../../../telemetry/telemetry-state.layer.ts";
import {
  pgDeltaCommandRuntimeLayer,
  pgDeltaDbConfigRuntimeLayer,
} from "../../../../../command-internal/pgdelta-engine-runtime.layer.ts";

export const dbSchemaDeclarativeSyncRuntimeLayer = Layer.mergeAll(
  pgDeltaDbConfigRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  identityStitchLayer,
  telemetryStateLayer,
  linkedDbResolverRuntimeLayer(["db", "schema", "declarative", "sync"]).pipe(
    Layer.provide(identityStitchLayer),
  ),
  commandRuntimeLayer(["db", "schema", "declarative", "sync"]),
  stdinLayer,
  machineErrorContextLayer,
);
