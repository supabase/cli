import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export type RealtimeJoinFailureReason = "rejected" | "timed_out" | "closed";

export type RealtimeEndpointFailureKind =
  | "not_found"
  | "unauthorized"
  | "server_error"
  | "unreachable"
  | "handshake_refused";

export class RealtimeTargetNotResolvedError extends Data.TaggedError(
  "RealtimeTargetNotResolvedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class RealtimeMutuallyExclusiveFlagsError extends Data.TaggedError(
  "RealtimeMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class RealtimeOutputFlagUnsupportedError extends Data.TaggedError(
  "RealtimeOutputFlagUnsupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class RealtimeInvalidUrlError extends Data.TaggedError("RealtimeInvalidUrlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "invalid_url" };
  }
}

export class RealtimeInvalidPayloadError extends Data.TaggedError("RealtimeInvalidPayloadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "invalid_content" };
  }
}

export class RealtimeInvalidOptionError extends Data.TaggedError("RealtimeInvalidOptionError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "bad_argument" };
  }
}

export class RealtimeConfigError extends Data.TaggedError("RealtimeConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class RealtimeApiKeysNetworkError extends Data.TaggedError("RealtimeApiKeysNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class RealtimeApiKeysStatusError extends Data.TaggedError("RealtimeApiKeysStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class RealtimeMissingApiKeyError extends Data.TaggedError("RealtimeMissingApiKeyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class RealtimeJoinFailedError extends Data.TaggedError("RealtimeJoinFailedError")<{
  readonly reason: RealtimeJoinFailureReason;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "rejected") {
      return { ...actionability.invalidInput, fingerprint_suffix: "realtime_join_rejected" };
    }
    if (this.reason === "closed") {
      return { ...actionability.externalNetwork, fingerprint_suffix: "realtime_channel_closed" };
    }
    return { ...actionability.externalNetwork, fingerprint_suffix: "realtime_join_timeout" };
  }
}

export class RealtimePostgresSubscriptionFailedError extends Data.TaggedError(
  "RealtimePostgresSubscriptionFailedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidConfig, fingerprint_suffix: "realtime_subscription_refused" };
  }
}

export class RealtimeBroadcastFailedError extends Data.TaggedError("RealtimeBroadcastFailedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "realtime_broadcast_unacked" };
  }
}

export class RealtimeSignInFailedError extends Data.TaggedError("RealtimeSignInFailedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.authToken, fingerprint_suffix: "auth" };
  }
}

export class RealtimeKeyRejectedError extends Data.TaggedError("RealtimeKeyRejectedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.authToken, fingerprint_suffix: "gateway_auth" };
  }
}

export class RealtimeEndpointUnhealthyError extends Data.TaggedError(
  "RealtimeEndpointUnhealthyError",
)<{
  readonly kind: RealtimeEndpointFailureKind;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.kind) {
      case "not_found":
        return { ...actionability.provideFlags, fingerprint_suffix: "not_found" };
      case "unauthorized":
        return { ...actionability.authToken, fingerprint_suffix: "gateway_auth" };
      case "server_error":
        return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
      case "handshake_refused":
        return { ...actionability.provideFlags, fingerprint_suffix: "realtime_handshake_refused" };
      default:
        return { ...actionability.externalNetwork, fingerprint_suffix: "connect" };
    }
  }
}
