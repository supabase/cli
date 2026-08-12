import { describe, expect, it } from "vitest";
import {
  DuplicateManagedIdentityError,
  InvalidManagedIdentityError,
  InvalidManagedPortError,
  InvalidManagedStackNameError,
  ManagedAbandonedOperationError,
  ManagedOperationInProgressError,
  ManagedOperationOwnershipError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  ManagedStackPublicationTimeoutError,
  UnsafeManagedStackPathError,
  UnsupportedManagedRegistryVersionError,
} from "./managed/model.ts";

const operation = {
  token: "018f8b4e-8e5c-7e32-a956-6f297fd05a2d",
  stackId: "stack-id",
  kind: "start",
  status: "active",
  startedAt: "2026-08-11T00:00:00.000Z",
} as const;

/**
 * Consumers cannot discriminate managed failures by class: they are plain
 * `Error` subclasses with no tag, and identifier minification renames the
 * constructors. The CLI's telemetry classifier therefore dispatches on `code`
 * (`apps/cli/src/shared/telemetry/error-actionability.ts`), so these literals
 * are a published contract rather than an implementation detail.
 */
describe("managed error contract", () => {
  it.each([
    [new InvalidManagedIdentityError("bad id"), "INVALID_MANAGED_IDENTITY"],
    [new UnsupportedManagedRegistryVersionError(3, 2), "UNSUPPORTED_MANAGED_REGISTRY_VERSION"],
    [new DuplicateManagedIdentityError("id", "a", "b"), "DUPLICATE_MANAGED_IDENTITY"],
    [new InvalidManagedStackNameError("Bad Name"), "MANAGED_INVALID_STACK_NAME"],
    [new InvalidManagedPortError(70_000, "api.port"), "MANAGED_INVALID_PORT"],
    [new ManagedStackNotFoundError("stack-id"), "MANAGED_STACK_NOT_FOUND"],
    [new ManagedStackNotStoppedError("stack-id"), "MANAGED_STACK_NOT_STOPPED"],
    [new ManagedOperationInProgressError("stack-id", operation), "MANAGED_OPERATION_IN_PROGRESS"],
    [new ManagedOperationOwnershipError("stack-id"), "MANAGED_OPERATION_OWNERSHIP_MISMATCH"],
    [new ManagedPortReservationError(54_321, "stack-id"), "MANAGED_PORT_ALREADY_RESERVED"],
    [new ManagedRunningStackPortChangeError("stack-id"), "MANAGED_RUNNING_STACK_PORT_CHANGE"],
    [new UnsafeManagedStackPathError("/tmp/escaped"), "UNSAFE_MANAGED_STACK_PATH"],
    [
      new ManagedStackInitializationError("stack-id", new Error("boom")),
      "MANAGED_STACK_INITIALIZATION_FAILED",
    ],
    [new ManagedStackPublicationTimeoutError("stack-id"), "MANAGED_STACK_PUBLICATION_TIMEOUT"],
    [new ManagedAbandonedOperationError("stack-id"), "MANAGED_OPERATION_REQUIRES_RECONCILIATION"],
  ])("exposes a stable code and class name on $name", (error, code) => {
    expect(error).toBeInstanceOf(ManagedStackError);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
    expect(error).not.toHaveProperty("_tag");
  });
});
