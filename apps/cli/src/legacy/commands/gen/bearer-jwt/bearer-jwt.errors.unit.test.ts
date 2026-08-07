import { describe, expect, it } from "vitest";
import { legacyBearerJwtErrorMessage } from "./bearer-jwt.errors.ts";

describe("legacyBearerJwtErrorMessage", () => {
  it("extracts .message from a real Error instance", () => {
    expect(legacyBearerJwtErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error cause", () => {
    expect(legacyBearerJwtErrorMessage("plain string cause")).toBe("plain string cause");
    expect(legacyBearerJwtErrorMessage(42)).toBe("42");
  });
});
