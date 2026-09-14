import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/** Positional template arg with no case-insensitive match — `"Invalid template: " + name`. */
export class BootstrapInvalidTemplateError extends Data.TaggedError(
  "BootstrapInvalidTemplateError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** GitHub samples listing failure — `failed to list samples`. */
export class BootstrapTemplateListError extends Data.TaggedError("BootstrapTemplateListError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/** Reading the target workdir failed — `failed to read workdir: ${cause}`. */
export class BootstrapWorkdirReadError extends Data.TaggedError("BootstrapWorkdirReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * User declined the overwrite prompt. Carries no suggestion frame since this is a
 * cancellation, not a fault.
 */
export class BootstrapOverwriteDeclinedError extends Data.TaggedError(
  "BootstrapOverwriteDeclinedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/** Template download failure (network, non-200 status, or an unsafe archive entry). */
export class BootstrapTemplateDownloadError extends Data.TaggedError(
  "BootstrapTemplateDownloadError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/**
 * Project health probe failed — `Error status <status>: <body>` (non-200) or
 * `Service not healthy: <name> (<status>)`.
 */
export class BootstrapHealthError extends Data.TaggedError("BootstrapHealthError")<{
  readonly message: string;
  /** Set when the health poll itself failed with a non-200; absent when the
   * service reported unhealthy. */
  readonly status?: number;
  /** Set when the health poll's response came back with a 200 the generated
   * client could not decode (`SchemaError`) — an API-response
   * problem, not a transport failure. */
  readonly decode?: boolean;
  /** Set when the health poll failed without any HTTP response (DNS, TLS,
   * timeout) — a network failure, not an API status. */
  readonly transport?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.status !== undefined) return statusCodeActionability(this.status);
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    if (this.transport === true) {
      return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
    }
    return actionability.apiStatus;
  }
}
