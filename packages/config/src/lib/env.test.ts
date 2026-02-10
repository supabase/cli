import { describe, test, expect } from "bun:test";
import { env } from "./env";

describe("env()", () => {
  test("adds env() pattern to JSON schema", () => {
    const json = env({ description: "test" }).toJSON();
    expect(json.pattern).toBe("^env\\([A-Z_][A-Z0-9_]*\\)$");
    expect(json.type).toBe("string");
  });

  test("does not add x-secret by default", () => {
    const json = env().toJSON();
    expect(json["x-secret"]).toBeUndefined();
    expect(json.secret).toBeUndefined();
  });

  test("adds x-secret when secret: true", () => {
    const json = env({ secret: true }).toJSON();
    expect(json["x-secret"]).toBe(true);
    expect(json.pattern).toBe("^env\\([A-Z_][A-Z0-9_]*\\)$");
    expect(json.secret).toBeUndefined(); // not leaked
  });
});
