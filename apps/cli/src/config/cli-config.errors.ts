import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { CliConfigTier } from "./cli-config-key.ts";

/**
 * A config key's winning value, or a flag binding, is invalid. `message` carries the wording the
 * per-key env override errors used; `envName` or `flag` names the offending source.
 */
export class CliConfigValueError extends Data.TaggedError("CliConfigValueError")<{
  readonly path: string;
  readonly tier: CliConfigTier;
  readonly message: string;
  readonly envName?: string;
  readonly flag?: string;
  /** Per-entry decode failures, merged when several keys fail in one load. */
  readonly issues?: ReadonlyArray<string>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
