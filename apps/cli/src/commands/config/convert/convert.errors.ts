import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory. */
export class ConfigConvertWorkdirError extends Data.TaggedError("ConfigConvertWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** The project config is missing or cannot be parsed. */
export class ConfigConvertLoadConfigError extends Data.TaggedError("ConfigConvertLoadConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** `config.toml` coexists with `config.json`/`config.jsonc`, which takes precedence. */
export class ConfigConvertAlreadyJsonError extends Data.TaggedError(
  "ConfigConvertAlreadyJsonError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** The converter refused the document; `config.toml` is left untouched. */
export class ConfigConvertUnsupportedError extends Data.TaggedError(
  "ConfigConvertUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** `config.toml` changed on disk between the read and the write. */
export class ConfigConvertFileChangedError extends Data.TaggedError(
  "ConfigConvertFileChangedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "conflict" };
  }
}

/** Writing `config.jsonc` or removing `config.toml` failed. */
export class ConfigConvertWriteError extends Data.TaggedError("ConfigConvertWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.permission, fingerprint_suffix: "filesystem" };
  }
}

/** The `-o/--output` flag was passed; this command only supports `--output-format`. */
export class ConfigConvertOutputFlagUnsupportedError extends Data.TaggedError(
  "ConfigConvertOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
