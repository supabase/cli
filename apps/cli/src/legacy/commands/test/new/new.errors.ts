import { Data } from "effect";

/**
 * The target test file already exists. Byte-matches Go's
 * `errors.New(path + " already exists.")` (`apps/cli-go/internal/test/new/new.go:26`).
 */
export class LegacyTestNewFileExistsError extends Data.TaggedError("LegacyTestNewFileExistsError")<{
  readonly path: string;
  readonly message: string;
}> {}

/**
 * Writing the test file failed (e.g. permission denied). Mirrors Go's
 * `utils.WriteFile` error (`new.go:28`).
 */
export class LegacyTestNewWriteError extends Data.TaggedError("LegacyTestNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {}
