import { Layer } from "effect";

import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import {
  migraRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  pgDeltaDbConfigRuntimeLayer,
} from "../../../command-internal/pgdelta-engine-runtime.layer.ts";

export const dbSchemaPullRuntimeLayer = (command: ReadonlyArray<string>) =>
  Layer.mergeAll(
    cliConfigValuesLayer,
    pgDeltaDbConfigRuntimeLayer,
    pgDeltaCommandRuntimeLayer,
    migraRuntimeLayer,
    identityStitchLayer,
    telemetryStateLayer,
    linkedDbResolverRuntimeLayer(command).pipe(Layer.provide(identityStitchLayer)),
    commandRuntimeLayer(command),
    stdinLayer,
  );

export const dbPullRuntimeLayer = dbSchemaPullRuntimeLayer(["db", "pull"]);
