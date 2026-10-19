import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { CliConfigTier } from "./cli-config-key.ts";

/**
 * A config key's winning value is invalid. `message` names the source that supplied it, `source`
 * repeats that source on its own, and `envName` or `flag` names the offending variable or flag.
 */
export class CliConfigValueError extends Data.TaggedError("CliConfigValueError")<{
  readonly path: string;
  readonly tier: CliConfigTier;
  readonly message: string;
  readonly source?: string;
  readonly envName?: string;
  readonly flag?: string;
  /** Per-entry decode failures, merged when several keys fail in one load. */
  readonly issues?: ReadonlyArray<string>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** A removed `SUPABASE_*` variable holds a value; `location` names the shell or project env file that set it. */
export class CliConfigRemovedEnvError extends Data.TaggedError("CliConfigRemovedEnvError")<{
  readonly envName: string;
  readonly replacement: string;
  readonly location: string;
}> {
  override get message(): string {
    return `${this.envName} (set in ${this.location}) is no longer supported. Use ${this.replacement} instead.`;
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Two flags assigned different values to the same config key. */
export class CliConfigFlagConflictError extends Data.TaggedError("CliConfigFlagConflictError")<{
  readonly path: string;
  readonly flags: readonly [string, string];
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
