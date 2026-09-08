import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { resolveAgentMode } from "./agent-mode.ts";

describe("resolveAgentMode", () => {
  it("honors the explicit flag and falls back to detection on auto", () => {
    expect(resolveAgentMode("yes", Option.none())).toBe(true);
    expect(resolveAgentMode("no", Option.some("cursor"))).toBe(false);
    expect(resolveAgentMode("auto", Option.some("cursor"))).toBe(true);
    expect(resolveAgentMode("auto", Option.none())).toBe(false);
  });
});
