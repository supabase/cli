import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a
 * directory. The CLI changes to the resolved workdir unconditionally, before
 * `start`'s own flag validation or handler body run, so a bad explicit
 * workdir must fail here first, before config load or any Docker access.
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
 * `config.toml` resolved to a value config validation rejects before `start`
 * ever brings up a container — e.g. an `auth.jwt_secret` shorter than 16
 * characters.
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
