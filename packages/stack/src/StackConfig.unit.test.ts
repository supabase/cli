import { describe, expect, it } from "vitest";
import {
  DEFAULT_STACK_READINESS_POLICY,
  resolveReadinessPolicy,
  type ReadinessPolicy,
} from "./StackConfig.ts";

const finite = (timeoutMs: number): ReadinessPolicy => ({ mode: "finite", timeoutMs });

describe("resolveReadinessPolicy", () => {
  it("uses the finite package default when neither level chooses a policy", () => {
    expect(resolveReadinessPolicy({})).toEqual(DEFAULT_STACK_READINESS_POLICY);
  });

  it("inherits finite and infinite stack policies", () => {
    expect(
      resolveReadinessPolicy({
        readyOptions: { mode: "inherit" },
        stackPolicy: finite(120_000),
      }),
    ).toEqual(finite(120_000));
    expect(
      resolveReadinessPolicy({
        readyOptions: { mode: "inherit" },
        stackPolicy: { mode: "infinite" },
      }),
    ).toEqual({ mode: "infinite" });
  });

  it("allows shorter and longer per-call finite policies", () => {
    expect(
      resolveReadinessPolicy({
        readyOptions: finite(5_000),
        stackPolicy: finite(120_000),
      }),
    ).toEqual(finite(5_000));
    expect(
      resolveReadinessPolicy({
        readyOptions: finite(300_000),
        stackPolicy: finite(120_000),
      }),
    ).toEqual(finite(300_000));
  });

  it("allows either level to opt into or override infinite waiting", () => {
    expect(
      resolveReadinessPolicy({
        readyOptions: { mode: "infinite" },
        stackPolicy: finite(120_000),
      }),
    ).toEqual({ mode: "infinite" });
    expect(
      resolveReadinessPolicy({
        readyOptions: finite(30_000),
        stackPolicy: { mode: "infinite" },
      }),
    ).toEqual(finite(30_000));
  });
});
