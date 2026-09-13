import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/** `create extension if not exists pgtap` failed. */
export class TestDbEnablePgtapError extends Data.TaggedError("TestDbEnablePgtapError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * `pg_prove` exited non-zero (test failures or a container error). The TAP
 * failure detail is already on stdout.
 */
export class TestDbRunError extends Data.TaggedError("TestDbRunError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * `pg_prove` ran but found nothing to execute. It reports that as `Result: NOTESTS`
 * and still exits 0, so without this the command reports success for a run that
 * executed zero tests (CLI-2194).
 */
export class TestDbNoTestsError extends Data.TaggedError("TestDbNoTestsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** More than one of `--db-url` / `--linked` / `--local` was set. */
export class TestDbMutuallyExclusiveFlagsError extends Data.TaggedError(
  "TestDbMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
