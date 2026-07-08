import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * `create extension if not exists pgtap` failed. Byte-matches Go's
 * `"failed to enable pgTAP: " + err` (`apps/cli-go/internal/db/test/test.go:70`).
 */
export class LegacyTestDbEnablePgtapError extends Data.TaggedError("LegacyTestDbEnablePgtapError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * `pg_prove` exited non-zero (test failures or a container error). Byte-matches
 * Go's `"error running container: exit " + code` (`apps/cli-go/internal/utils/docker.go`
 * `DockerStreamLogs`). The TAP failure detail is already on stdout.
 */
export class LegacyTestDbRunError extends Data.TaggedError("LegacyTestDbRunError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * More than one of `--db-url` / `--linked` / `--local` was set. Reproduces
 * cobra's `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` error from
 * `apps/cli-go/cmd/db.go:485`, byte-for-byte.
 */
export class LegacyTestDbMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyTestDbMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
