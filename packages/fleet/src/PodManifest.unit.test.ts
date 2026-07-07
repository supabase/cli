import { describe, expect, it } from "vitest";
import { baseTemplateKey, templateKey } from "./PodManifest.ts";

describe("templateKey", () => {
  it("is stable across key order", () => {
    expect(templateKey({ postgres: "17.6.1.143", auth: "2.192.0" })).toBe(
      templateKey({ auth: "2.192.0", postgres: "17.6.1.143" }),
    );
  });
  it("changes when any version changes", () => {
    expect(templateKey({ postgres: "17.6.1.143", auth: "2.192.0" })).not.toBe(
      templateKey({ postgres: "17.6.1.143", auth: "2.192.1" }),
    );
  });
  it("includes enabled services in canonical order", () => {
    const versions = { postgres: "17.6.1.143", auth: "2.192.0" };
    expect(templateKey(versions, ["auth", "postgrest"])).toBe(
      templateKey(versions, ["postgrest", "auth"]),
    );
    expect(templateKey(versions, ["auth"])).not.toBe(templateKey(versions, ["auth", "postgrest"]));
  });
  it("base key is stable and path-safe", () => {
    expect(baseTemplateKey("17.6.1.143")).toBe(baseTemplateKey("17.6.1.143"));
    expect(baseTemplateKey("../17.6.1.143")).toMatch(/^pg-[a-f0-9]{16}$/);
    expect(baseTemplateKey("../17.6.1.143")).not.toContain("..");
  });
});
