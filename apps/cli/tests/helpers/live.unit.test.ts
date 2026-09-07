import { describe, expect, it } from "vitest";

import { requireCliSuccess } from "./cli.ts";
import { throwWithCleanup } from "./live.ts";

describe("requireCliSuccess", () => {
  it("passes a zero exit through", () => {
    expect(() => requireCliSuccess({ exitCode: 0, stdout: "", stderr: "" }, "cmd")).not.toThrow();
  });

  it("reports a nonzero exit with the output attached", () => {
    expect(() => requireCliSuccess({ exitCode: 2, stdout: "out", stderr: "err" }, "cmd")).toThrow(
      /cmd failed \(exit 2\)\nstdout:\nout\nstderr:\nerr/u,
    );
  });

  it("names the harness exit bound when the subprocess was SIGKILLed", () => {
    expect(() =>
      requireCliSuccess({ exitCode: 1, stdout: "", stderr: "", timedOutAfterMs: 90_000 }, "cmd"),
    ).toThrow(/cmd failed \(exit 1; harness SIGKILLed it after 90000ms without exit\)/u);
  });
});

describe("throwWithCleanup", () => {
  it("rethrows the primary failure when cleanup succeeds", () => {
    const primary = new Error("target failed");

    expect(() => throwWithCleanup(primary, [])).toThrow(primary);
  });

  it("throws the cleanup failure when the target succeeds", () => {
    const cleanup = new Error("cleanup failed");

    expect(() => throwWithCleanup(undefined, [cleanup])).toThrow(cleanup);
  });

  it("preserves the primary and every cleanup failure", () => {
    const primary = new Error("target failed");
    const cleanup = [new Error("first cleanup failed"), new Error("second cleanup failed")];
    let thrown: unknown;

    try {
      throwWithCleanup(primary, cleanup);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) return;
    expect(thrown.errors).toEqual([primary, ...cleanup]);
  });
});
