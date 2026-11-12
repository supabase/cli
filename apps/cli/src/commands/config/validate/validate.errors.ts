import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory. */
export class ConfigValidateWorkdirError extends Data.TaggedError("ConfigValidateWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** The project config is missing or could not be read at all. */
export class ConfigValidateLoadError extends Data.TaggedError("ConfigValidateLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The `-o/--output` flag was passed; this command only supports `--output-format`. */
export class ConfigValidateOutputFlagUnsupportedError extends Data.TaggedError(
  "ConfigValidateOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** The config has problems; classifies the exit-code-1 run that reports them without failing the command. */
export class ConfigValidateProblemsError extends Data.TaggedError("ConfigValidateProblemsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
