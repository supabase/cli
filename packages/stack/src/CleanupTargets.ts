import { Schema } from "effect";

export interface CleanupTargets {
  readonly dockerContainerNames: ReadonlyArray<string>;
}

export const CleanupTargetsSchema = Schema.Struct({
  dockerContainerNames: Schema.Array(Schema.String),
});
