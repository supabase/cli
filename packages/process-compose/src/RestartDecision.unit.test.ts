import { describe, expect, it } from "vitest";
import { decideRestart, type LifecycleCause } from "./RestartDecision.ts";
import type { RestartPolicy } from "./ServiceDef.ts";

const exit = (exitCode: number): LifecycleCause => ({ _tag: "ProcessExit", exitCode });
const unhealthy: LifecycleCause = { _tag: "Unhealthy" };

describe("decideRestart", () => {
  it.each([
    ["no", exit(0), "Terminate"],
    ["no", exit(1), "Terminate"],
    ["no", unhealthy, "KeepRunningUnhealthy"],
    ["on-failure", exit(0), "Terminate"],
    ["on-failure", exit(1), "Restart"],
    ["on-failure", unhealthy, "Restart"],
    ["always", exit(0), "Restart"],
    ["always", exit(1), "Restart"],
    ["always", unhealthy, "Restart"],
    ["unless-stopped", exit(0), "Restart"],
    ["unless-stopped", exit(1), "Restart"],
    ["unless-stopped", unhealthy, "Restart"],
  ] as const)("applies %s to %o", (policy, cause, expected) => {
    expect(
      decideRestart({
        policy,
        cause,
        restartCount: 0,
        maxRestarts: 1,
        desired: "running",
      })._tag,
    ).toBe(expected);
  });

  it.each(["no", "on-failure", "always", "unless-stopped"] as const)(
    "never restarts %s after stop was requested",
    (policy: RestartPolicy) => {
      expect(
        decideRestart({
          policy,
          cause: exit(1),
          restartCount: 0,
          maxRestarts: 0,
          desired: "stopped",
        }),
      ).toEqual({ _tag: "Terminate", reason: "NotDesired" });
    },
  );

  it("treats zero maxRestarts as unlimited", () => {
    expect(
      decideRestart({
        policy: "always",
        cause: unhealthy,
        restartCount: 1_000,
        maxRestarts: 0,
        desired: "running",
      }),
    ).toEqual({ _tag: "Restart", restartCount: 1_001 });
  });

  it("terminates when the restart budget is exhausted", () => {
    expect(
      decideRestart({
        policy: "always",
        cause: unhealthy,
        restartCount: 2,
        maxRestarts: 2,
        desired: "running",
      }),
    ).toEqual({ _tag: "Terminate", reason: "BudgetExhausted" });
  });
});
