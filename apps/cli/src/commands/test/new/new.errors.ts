import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * The target test file already exists. Message format:
 * `<path> already exists.`
 */
export class TestNewFileExistsError extends Data.TaggedError("TestNewFileExistsError")<{
  readonly path: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Writing the test file failed (e.g. permission denied). */
export class TestNewWriteError extends Data.TaggedError("TestNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
