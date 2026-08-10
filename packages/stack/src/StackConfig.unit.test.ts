import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  DEFAULT_STACK_READINESS_POLICY,
  ReadyOptionsSchema,
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
        stackPolicy: finite(180_000),
      }),
    ).toEqual(finite(180_000));
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
        stackPolicy: finite(180_000),
      }),
    ).toEqual(finite(5_000));
    expect(
      resolveReadinessPolicy({
        readyOptions: finite(300_000),
        stackPolicy: finite(180_000),
      }),
    ).toEqual(finite(300_000));
  });

  it("allows either level to opt into or override infinite waiting", () => {
    expect(
      resolveReadinessPolicy({
        readyOptions: { mode: "infinite" },
        stackPolicy: finite(180_000),
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

describe("ReadyOptionsSchema", () => {
  const decode = Schema.decodeUnknownSync(ReadyOptionsSchema);

  it("accepts the three readiness override modes", () => {
    expect(decode({ mode: "inherit" })).toEqual({ mode: "inherit" });
    expect(decode({ mode: "infinite" })).toEqual({ mode: "infinite" });
    expect(decode({ mode: "finite", timeoutMs: 25 })).toEqual({
      mode: "finite",
      timeoutMs: 25,
    });
  });

  it("rejects malformed and non-positive finite deadlines", () => {
    expect(() => decode({ mode: "finite", timeoutMs: 0 })).toThrow();
    expect(() => decode({ mode: "finite", timeoutMs: -1 })).toThrow();
    expect(() => decode({ mode: "forever" })).toThrow();
  });
});
