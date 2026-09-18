import { Data } from "effect";

interface PreparationErrorFields {
  readonly message: string;
  readonly cause?: unknown;
  readonly field?: string;
  readonly value?: unknown;
  readonly service?: string;
  readonly version?: string;
  readonly platform?: string;
  readonly target?: string;
  readonly path?: string;
  readonly key?: string;
}

export class PreparationError extends Data.TaggedError(
  "PreparationError",
)<PreparationErrorFields> {}

export class ArtifactIntegrityError extends Data.TaggedError("ArtifactIntegrityError")<
  PreparationErrorFields & {
    readonly expected?: string;
    readonly actual?: string;
  }
> {}
