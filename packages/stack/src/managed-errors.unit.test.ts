import { describe, expect, it } from "vitest";
import {
  ManagedExactPortOccupiedError,
  ManagedLegacyPortConflictError,
  ManagedPortAllocationError,
  ManagedPortClaimRaceError,
  ManagedRuntimeStartError,
  ManagedStickyPortOccupiedError,
} from "./managed/model.ts";

describe("managed port error messages", () => {
  it.each([
    [
      new ManagedExactPortOccupiedError({
        key: "api.port",
        port: 54_321,
        ownerStackId: "stack-b",
        ownerStackName: "preview",
      }),
      "Port 54321 configured by api.port is occupied by managed stack preview (stack-b)",
    ],
    [
      new ManagedStickyPortOccupiedError({
        key: "api.port",
        port: 54_321,
        stackId: "stack-a",
        ownerStackId: "stack-b",
        ownerStackName: "preview",
      }),
      "Sticky port 54321 for api.port on managed stack stack-a is occupied by managed stack preview (stack-b)",
    ],
    [
      new ManagedPortClaimRaceError({
        stackId: "stack-a",
        port: 54_321,
        ownerStackId: "stack-b",
      }),
      "Managed stack stack-a lost port 54321 to managed stack stack-b while claiming its allocation",
    ],
    [
      new ManagedPortAllocationError({
        fields: ["apiPort", "dbPort"],
        cause: new Error("allocator failed"),
      }),
      "Failed to allocate managed ports apiPort, dbPort: allocator failed",
    ],
    [
      new ManagedRuntimeStartError({ cause: new Error("runtime failed") }),
      "Managed runtime failed to start: runtime failed",
    ],
    [
      new ManagedLegacyPortConflictError({
        key: "api.port",
        port: 54_321,
        ownerId: "legacy-project",
      }),
      "The matching legacy stack legacy-project is still running on api.port 54321",
    ],
  ])("renders %s", (error, expected) => {
    expect(error.message).toBe(expected);
  });
});
