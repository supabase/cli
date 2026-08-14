import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { legacyResolveAgentMode } from "./legacy-agent-mode.ts";

describe("legacyResolveAgentMode", () => {
  it("honors the explicit flag and falls back to detection on auto", () => {
    expect(legacyResolveAgentMode("yes", Option.none())).toBe(true);
    expect(legacyResolveAgentMode("no", Option.some("cursor"))).toBe(false);
    expect(legacyResolveAgentMode("auto", Option.some("cursor"))).toBe(true);
    expect(legacyResolveAgentMode("auto", Option.none())).toBe(false);
  });
});
