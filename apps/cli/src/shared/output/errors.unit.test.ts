import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";
import { failureBesideClosedStdout, StdoutClosedError } from "./errors.ts";

describe("failureBesideClosedStdout", () => {
  const closed = Cause.die(new StdoutClosedError());

  it("treats a run ended only by a closed stdout as having nothing to report", () => {
    expect(failureBesideClosedStdout(closed)).toBeUndefined();
    expect(failureBesideClosedStdout(Cause.combine(closed, Cause.interrupt(1)))).toBeUndefined();
  });

  it("keeps a typed failure or defect that happened alongside the closed stdout", () => {
    const failure = new Error("cleanup failed");

    expect(failureBesideClosedStdout(Cause.combine(Cause.fail(failure), closed))).toEqual(
      Cause.fail(failure),
    );
    expect(failureBesideClosedStdout(Cause.combine(closed, Cause.die(failure)))).toEqual(
      Cause.die(failure),
    );
  });

  it("returns a cause without a closed stdout unchanged", () => {
    const cause = Cause.fail("boom");
    expect(failureBesideClosedStdout(cause)).toBe(cause);
  });
});
