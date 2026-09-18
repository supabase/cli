import { describe, expect, it } from "vitest";
import { bearerJwtErrorMessage } from "./bearer-jwt.errors.ts";

describe("bearerJwtErrorMessage", () => {
  it("extracts .message from a real Error instance", () => {
    expect(bearerJwtErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error cause", () => {
    expect(bearerJwtErrorMessage("plain string cause")).toBe("plain string cause");
    expect(bearerJwtErrorMessage(42)).toBe("42");
  });
});
