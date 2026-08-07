import { Schema } from "effect";
import type { ServiceName } from "./ServiceName.ts";

export interface CleanupTargets {
  readonly dockerContainerNames: ReadonlyArray<string>;
}

export const CleanupTargetsSchema = Schema.Struct({
  dockerContainerNames: Schema.Array(Schema.String),
});

export const dockerContainerName = (service: ServiceName, apiPort: number): string =>
  `supabase-${service}-${apiPort}`;
