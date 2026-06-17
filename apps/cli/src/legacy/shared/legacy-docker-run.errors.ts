import { Data } from "effect";

/** Spawning or running the `docker` CLI failed (binary missing, daemon down, non-spawn failure). */
export class LegacyDockerRunError extends Data.TaggedError("LegacyDockerRunError")<{
  readonly message: string;
}> {}
