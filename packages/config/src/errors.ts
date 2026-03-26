import { Data } from "effect";
import type { ConfigFormat } from "./io.ts";

export class ProjectConfigParseError extends Data.TaggedError("ProjectConfigParseError")<{
  readonly path: string;
  readonly format: ConfigFormat;
  readonly cause: unknown;
}> {}

export class ProjectEnvParseError extends Data.TaggedError("ProjectEnvParseError")<{
  readonly path: string;
  readonly line: number;
}> {}

export class MissingProjectEnvVarError extends Data.TaggedError("MissingProjectEnvVarError")<{
  readonly configPath: string;
  readonly envName: string;
}> {}

export class MissingProjectConfigValueError extends Data.TaggedError(
  "MissingProjectConfigValueError",
)<{
  readonly configPath: string;
}> {}
