import { Cause } from "effect";

/**
 * Closed classification of why a stack operation failed, carried by `StackError.kind` and by
 * each failed composition outcome. Values are source-owned identifiers, never error text.
 */
const stackFailureKinds = [
  "engine-unavailable",
  "engine-timeout",
  "engine-command",
  "image-pull",
  "port-conflict",
  "port-allocation",
  "artifact-download",
  "artifact-integrity",
  "platform-unsupported",
  "process-spawn",
  "process-exit",
  "process-stop",
  "health-timeout",
  "health-check",
  "database-bootstrap",
  "configuration",
  "state",
  "filesystem",
  "owner-startup",
  "owner-connection",
  "owner-exit",
  "lease-held",
  "already-exists",
  "timeout",
] as const;

export type StackFailureKind = (typeof stackFailureKinds)[number];

const knownKinds = new Set<string>(stackFailureKinds);

/**
 * Narrows a wire value to a known kind. The wire field is an open string so a client decoding
 * an owner from a newer release ignores kinds it does not know instead of rejecting the error.
 */
export const isStackFailureKind = (value: unknown): value is StackFailureKind =>
  typeof value === "string" && knownKinds.has(value);

/** Kinds that only describe the mechanism, so an enclosing domain error names the failure better. */
const generalKinds = new Set<StackFailureKind>(["filesystem", "timeout", "configuration"]);

const maxDepth = 32;

const serviceOperationKinds: Readonly<Record<string, StackFailureKind>> = {
  exit: "process-exit",
  stop: "process-stop",
  remove: "process-stop",
  health: "health-check",
  bootstrap: "database-bootstrap",
  input: "configuration",
  config: "configuration",
  compose: "configuration",
};

const hostReasonKinds: Readonly<Record<string, StackFailureKind>> = {
  "connection-failure": "owner-connection",
  "owner-starting": "owner-startup",
  sweeping: "lease-held",
  "runtime-unavailable": "engine-unavailable",
  "invalid-owner-pid": "owner-exit",
  "owner-exit-pending": "owner-exit",
  "owner-exit-zombie": "owner-exit",
  "owner-exit-probe": "owner-exit",
};

const hostOperationKinds: Readonly<Record<string, StackFailureKind>> = {
  startup: "owner-startup",
  connect: "owner-connection",
  shutdown: "owner-connection",
  "shutdown-exit": "owner-exit",
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const lookup = (table: Readonly<Record<string, StackFailureKind>>, key: unknown) =>
  typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;

/** `scope` is the nearest enclosing service operation, or `engine` inside a container command. */
const classify = (
  value: unknown,
  scope: string | undefined,
  seen: Set<object>,
  depth: number,
): StackFailureKind | undefined => {
  if (!isRecord(value) || seen.has(value) || depth > maxDepth) return undefined;
  seen.add(value);
  const visit = (next: unknown, nextScope = scope) => classify(next, nextScope, seen, depth + 1);
  if (Cause.isCause(value)) {
    for (const reason of value.reasons) {
      const kind = Cause.isFailReason(reason)
        ? visit(reason.error)
        : Cause.isDieReason(reason)
          ? visit(reason.defect)
          : undefined;
      if (kind !== undefined) return kind;
    }
    return undefined;
  }
  if (Cause.isTimeoutError(value))
    return scope === "health"
      ? "health-timeout"
      : scope === "engine"
        ? "engine-timeout"
        : "timeout";
  if (isStackFailureKind(value.kind)) return value.kind;
  const nested = () => visit(value.cause);
  const within = (own: StackFailureKind | undefined) => {
    const inner = nested();
    return inner !== undefined && !generalKinds.has(inner) ? inner : (own ?? inner);
  };
  switch (value._tag) {
    case "StackError":
      return value.reason === "runtime-unavailable" ? "engine-unavailable" : undefined;
    case "ContainerError": {
      const inner = visit(value.cause, "engine");
      if (
        value.operation === "pull" &&
        inner !== "engine-unavailable" &&
        inner !== "engine-timeout"
      )
        return "image-pull";
      return inner ?? "engine-command";
    }
    case "ContainerLaunchError":
    case "ServiceLaunchError":
      return visit(value.failure);
    case "NativePortCollision":
    case "PortError":
      return "port-allocation";
    case "NativeProcessError":
      return scope === "launch"
        ? "process-spawn"
        : scope === "stop" || scope === "remove"
          ? "process-stop"
          : undefined;
    case "ServiceError":
      return (
        visit(value.cause, typeof value.operation === "string" ? value.operation : scope) ??
        lookup(serviceOperationKinds, value.operation)
      );
    case "ArtifactError":
    case "PreparationError": {
      // A local cache write failing is not a download failure.
      const inner = nested();
      return inner === undefined || inner === "timeout" || inner === "configuration"
        ? "artifact-download"
        : inner;
    }
    case "ArtifactIntegrityError":
      return "artifact-integrity";
    case "DatabaseBootstrapError":
      return within("database-bootstrap");
    case "CatalogError":
      return within(
        value.operation === "config" || value.cause === undefined ? "configuration" : undefined,
      );
    case "SupabaseCompositionError":
      return within(value.cause === undefined ? "configuration" : undefined);
    case "InvalidStackIdentityError":
    case "InvalidProjectRootError":
    case "SchemaError":
      return "configuration";
    case "Namespace.NamespaceError":
      return within("state");
    case "Namespace.LeaseHeldError":
      return "lease-held";
    case "Namespace.EnvironmentOverrideError":
    case "Namespace.EnvironmentSymlinkError":
      return "configuration";
    case "StackHostError":
      return value.reason === "lease-held"
        ? "lease-held"
        : value.reason === "runtime-unavailable"
          ? "engine-unavailable"
          : nested();
    case "HostProcessError":
      return (
        lookup(hostReasonKinds, value.reason) ?? within(lookup(hostOperationKinds, value.operation))
      );
    case "RpcClientError":
      return "owner-connection";
    case "OrchestratorError": {
      const inner = nested();
      if (inner !== undefined || !Array.isArray(value.outcomes)) return inner;
      for (const outcome of value.outcomes) {
        const kind =
          isRecord(outcome) && isRecord(outcome.result) ? visit(outcome.result.cause) : undefined;
        if (kind !== undefined) return kind;
      }
      return undefined;
    }
    case "PlatformError":
      return isRecord(value.reason) && value.reason.module === "FileSystem"
        ? "filesystem"
        : undefined;
    default:
      return nested();
  }
};

/**
 * Classifies a failure, a `Cause`, or a defect by walking its typed error chain. The most specific
 * typed signal wins; error text is never read.
 */
export const failureKind = (cause: unknown): StackFailureKind | undefined =>
  classify(cause, undefined, new Set(), 0);
