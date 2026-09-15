import { Layer } from "effect";

import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import { realtimeSessionsLayer } from "./realtime-session.service.ts";

export const inspectRealtimeRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(storageGatewayRuntimeLayer(subcommand), realtimeSessionsLayer);
