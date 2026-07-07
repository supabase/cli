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
  it("base key is human-readable", () => {
    expect(baseTemplateKey("17.6.1.143")).toBe("pg-17.6.1.143");
  });
});
