import { describe, expect, test } from "vitest";
import { Redacted } from "effect";
import { resolveCliConfigValue, resolveCliConfigSubtree } from "../index.ts";

// Behavioral coverage of the two public sync resolvers, imported from the
// public `.` entrypoint (not `./resolve.ts` directly) — this is the exact
// surface an external consumer sees, options param removed (CLI-2234).

describe("resolveCliConfigValue", () => {
  test("a plain leaf passes through unchanged", () => {
    expect(resolveCliConfigValue("hello", { values: {} }, "some.path")).toBe("hello");
  });

  test("an env(NAME) reference resolves from the supplied values", () => {
    expect(resolveCliConfigValue("env(FOO)", { values: { FOO: "bar" } }, "some.path")).toBe("bar");
  });

  test("an unresolved env(NAME) reference is preserved verbatim", () => {
    expect(resolveCliConfigValue("env(FOO)", { values: {} }, "some.path")).toBe("env(FOO)");
  });

  test("a value at a schema-known secret path resolves and is wrapped in Redacted", () => {
    const resolved = resolveCliConfigValue(
      "env(OPENAI_API_KEY)",
      { values: { OPENAI_API_KEY: "sk-test" } },
      "studio.openai_api_key",
    );

    expect(Redacted.isRedacted(resolved)).toBe(true);
    if (Redacted.isRedacted(resolved)) {
      expect(Redacted.value(resolved)).toBe("sk-test");
    }
  });
});

describe("resolveCliConfigSubtree", () => {
  test("resolves and redacts nested leaves under a path prefix", () => {
    const resolved = resolveCliConfigSubtree(
      { openai_api_key: "env(OPENAI_API_KEY)", api_url: "http://127.0.0.1" },
      { values: { OPENAI_API_KEY: "sk-test" } },
      "studio",
    );

    expect(resolved.api_url).toBe("http://127.0.0.1");
    expect(Redacted.isRedacted(resolved.openai_api_key)).toBe(true);
    if (Redacted.isRedacted(resolved.openai_api_key)) {
      expect(Redacted.value(resolved.openai_api_key)).toBe("sk-test");
    }
  });
});
