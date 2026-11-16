import { Data } from "effect";

import type { PlanGateEntitlement } from "../../shared/output/normalize-error.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/** The Management API answered a generated command with a non-2xx status. */
export class ApiCommandStatusError extends Data.TaggedError("ApiCommandStatusError")<{
  readonly status: number;
  readonly message: string;
  readonly apiCode?: string | undefined;
  readonly hint?: string | undefined;
  readonly entitlement?: PlanGateEntitlement | undefined;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** The invocation cannot form a valid request; nothing was sent. */
export class ApiCommandUsageError extends Data.TaggedError("ApiCommandUsageError")<{
  readonly message: string;
  readonly hint?: string | undefined;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** `--wait` observed the operation reach a failed status. */
export class ApiCommandOperationFailedError extends Data.TaggedError(
  "ApiCommandOperationFailedError",
)<{
  readonly message: string;
  readonly status: string;
  readonly hint: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}

/** `--wait` reached its timeout before the operation settled. */
export class ApiCommandWaitTimeoutError extends Data.TaggedError("ApiCommandWaitTimeoutError")<{
  readonly message: string;
  readonly timeoutMillis: number;
  readonly hint: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "operation_timeout" };
  }
}
