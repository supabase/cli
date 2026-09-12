import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** No `supabase/config.toml` or `supabase/config.json` to record the opt-in in. */
export class ExperimentsProjectNotFoundError extends Data.TaggedError(
  "ExperimentsProjectNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The config file exists but could not be read. */
export class ExperimentsConfigReadError extends Data.TaggedError("ExperimentsConfigReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.permission, fingerprint_suffix: "filesystem" };
  }
}

/**
 * The surgical editor refused the document's layout — most often a second `[experimental]`
 * table header, which leaves the file unparseable and every experiment silently off.
 */
export class ExperimentsUnsupportedLayoutError extends Data.TaggedError(
  "ExperimentsUnsupportedLayoutError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The edited document could not be written back. */
export class ExperimentsWriteError extends Data.TaggedError("ExperimentsWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.permission, fingerprint_suffix: "filesystem" };
  }
}

/** `-o`/`--output` carries no meaning here; `--output-format` is the machine-output flag. */
export class ExperimentsOutputFlagUnsupportedError extends Data.TaggedError(
  "ExperimentsOutputFlagUnsupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
