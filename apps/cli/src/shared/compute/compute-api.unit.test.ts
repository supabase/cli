import { describe, expect, it } from "vitest";
import { isComputeServing, type ComputeRecord } from "./compute-api.ts";

const record = (overrides: Partial<ComputeRecord> = {}): ComputeRecord => ({
  name: "api",
  spec: { size: "2gb-1vcpu", exposure: "public", instances: 2 },
  buildState: "active",
  ...overrides,
});

describe("isComputeServing", () => {
  it("is satisfied when every declared instance is ready and current", () => {
    expect(
      isComputeServing(record({ instances: { declared: 2, live: 2, ready: 2, stale: 0 } })),
    ).toBe(true);
  });

  // The field is omitted entirely until the first image lands — which is exactly when a wait
  // matters most, so an absent tally must never read as convergence.
  it("is not satisfied when the tally is absent", () => {
    expect(isComputeServing(record())).toBe(false);
  });

  // `instances_error` replaces the tally when the read-through fails. It reports nothing about
  // how many instances are up, so it is a reason to keep waiting.
  it("is not satisfied when the read-through failed", () => {
    expect(isComputeServing(record({ instancesError: "instances are unavailable" }))).toBe(false);
  });

  it("is not satisfied while instances are still starting", () => {
    expect(
      isComputeServing(record({ instances: { declared: 2, live: 2, ready: 1, stale: 0 } })),
    ).toBe(false);
  });

  // The term that carries a bare-image redeploy: no new image version is produced, so the
  // rotation cutoff is the only thing marking instances still on the old code.
  it("is not satisfied while an instance is still on the previous code", () => {
    expect(
      isComputeServing(record({ instances: { declared: 1, live: 1, ready: 1, stale: 1 } })),
    ).toBe(false);
  });

  // A scale-down leaves surplus instances serving until the control plane trims them.
  it("is not satisfied while surplus instances are still live", () => {
    expect(
      isComputeServing(record({ instances: { declared: 1, live: 3, ready: 3, stale: 0 } })),
    ).toBe(false);
  });
});
