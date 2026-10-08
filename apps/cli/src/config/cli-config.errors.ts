import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { CliConfigTier } from "./cli-config-key.ts";

/** A single config key's winning value failed to decode, so it never reaches a consumer. */
export class CliConfigValueError extends Data.TaggedError("CliConfigValueError")<{
  readonly path: string;
  readonly tier: CliConfigTier;
  readonly message: string;
  readonly envName?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The config document, project env files, or remote selection could not be loaded. */
export class CliConfigLoadError extends Data.TaggedError("CliConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
