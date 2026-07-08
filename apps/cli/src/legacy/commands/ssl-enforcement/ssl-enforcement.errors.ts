import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class LegacySslEnforcementGetNetworkError extends Data.TaggedError(
  "LegacySslEnforcementGetNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacySslEnforcementGetUnexpectedStatusError extends Data.TaggedError(
  "LegacySslEnforcementGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacySslEnforcementUpdateNetworkError extends Data.TaggedError(
  "LegacySslEnforcementUpdateNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacySslEnforcementUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacySslEnforcementUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

// Verbatim Go string from `apps/cli-go/internal/ssl_enforcement/update/update.go:27`.
export class LegacySslEnforcementNoEnableDisableFlagError extends Data.TaggedError(
  "LegacySslEnforcementNoEnableDisableFlagError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "enable/disable not specified" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Verbatim cobra string for parity with Go's `MarkFlagsMutuallyExclusive`
// (`apps/cli-go/cmd/sslEnforcement.go:46`). Effect CLI has no built-in
// equivalent, so we enforce it at handler entry.
export class LegacySslEnforcementMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacySslEnforcementMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "if any flags in the group [enable-db-ssl-enforcement disable-db-ssl-enforcement] are set none of the others can be",
    });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
