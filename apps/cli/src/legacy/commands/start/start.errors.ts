import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a
 * directory. Mirrors Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:
 * 231-250`), which unconditionally `os.Chdir(workdir)`s in `PersistentPreRunE`
 * (`apps/cli-go/cmd/root.go:93-105`) — before `start`'s own flag validation or
 * `RunE`, so a bad explicit workdir must fail here first, before config load
 * or any Docker access.
 */
export class LegacyStartWorkdirError extends Data.TaggedError("LegacyStartWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Loading `config.toml` failed for a reason other than the file being absent (malformed TOML). */
export class LegacyStartConfigLoadError extends Data.TaggedError("LegacyStartConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * `config.toml` resolved to a value `Config.Validate` would reject before
 * `start` ever brings up a container — e.g. an `auth.jwt_secret` shorter than
 * 16 characters (`pkg/config/apikeys.go:45-47`).
 */
export class LegacyStartInvalidConfigError extends Data.TaggedError(
  "LegacyStartInvalidConfigError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
