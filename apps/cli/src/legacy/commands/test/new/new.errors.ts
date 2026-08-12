import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * The target test file already exists. Byte-matches Go's
 * `errors.New(path + " already exists.")` (`apps/cli-go/internal/test/new/new.go:26`,
 * deleted in CLI-1970; last present at commit 7b469f5b3).
 */
export class LegacyTestNewFileExistsError extends Data.TaggedError("LegacyTestNewFileExistsError")<{
  readonly path: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Writing the test file failed (e.g. permission denied). Mirrors Go's
 * `utils.WriteFile` error (`new.go:28`).
 */
export class LegacyTestNewWriteError extends Data.TaggedError("LegacyTestNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
