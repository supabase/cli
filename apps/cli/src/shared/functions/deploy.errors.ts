import { Schema } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class ConflictingFunctionDeployFlagsError extends Schema.TaggedError<ConflictingFunctionDeployFlagsError>()(
  "ConflictingFunctionDeployFlagsError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class FunctionDeployJobsRequiresApiError extends Schema.TaggedError<FunctionDeployJobsRequiresApiError>()(
  "FunctionDeployJobsRequiresApiError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class InvalidFunctionDeploySlugError extends Schema.TaggedError<InvalidFunctionDeploySlugError>()(
  "InvalidFunctionDeploySlugError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class NoFunctionsToDeployError extends Schema.TaggedError<NoFunctionsToDeployError>()(
  "NoFunctionsToDeployError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class FunctionDeployCancelledError extends Schema.TaggedError<FunctionDeployCancelledError>()(
  "FunctionDeployCancelledError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

export class FunctionImportNotDirectoryError extends Schema.TaggedError<FunctionImportNotDirectoryError>()(
  "FunctionImportNotDirectoryError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** An asset, import map, or import-map target resolved outside its allowed root. */
export class FunctionAssetOutsideRootError extends Schema.TaggedError<FunctionAssetOutsideRootError>()(
  "FunctionAssetOutsideRootError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** A configured entrypoint, static file, or import map resolved to a directory. */
export class FunctionAssetIsDirectoryError extends Schema.TaggedError<FunctionAssetIsDirectoryError>()(
  "FunctionAssetIsDirectoryError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** A `static_files` glob pattern matched no files on disk. */
export class FunctionStaticPatternNoMatchError extends Schema.TaggedError<FunctionStaticPatternNoMatchError>()(
  "FunctionStaticPatternNoMatchError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** A `deno.json`/`deno.jsonc` or import map file failed to parse. */
export class FunctionImportMapParseError extends Schema.TaggedError<FunctionImportMapParseError>()(
  "FunctionImportMapParseError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The Docker bundler container exited unsuccessfully. */
export class FunctionBundleFailedError extends Schema.TaggedError<FunctionBundleFailedError>()(
  "FunctionBundleFailedError",
  {
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.toolFailed;
  }
}
