import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";
import { mapToServiceError } from "./Session.ts";

describe("mapToServiceError", () => {
  it("names an error whose cause carries no message", () => {
    const failure = mapToServiceError("stop", new Cause.UnknownError(undefined));

    expect(failure.message).toBe("UnknownError");
  });

  it("describes a wrapped error without a message by its cause", () => {
    const cause = new Cause.UnknownError(new Error("container is gone"));
    const failure = mapToServiceError("stop", cause);

    expect(failure.message).toBe("container is gone");
  });
});
