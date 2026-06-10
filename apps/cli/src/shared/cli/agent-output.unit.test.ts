import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { resolveAgentOutputFormat } from "./agent-output.ts";

describe("resolveAgentOutputFormat", () => {
  it("defaults a coding agent to json", () => {
    expect(resolveAgentOutputFormat(Option.none(), true)).toBe("json");
  });

  it("defaults a non-agent to text", () => {
    expect(resolveAgentOutputFormat(Option.none(), false)).toBe("text");
  });

  it("honors an explicit format over agent detection", () => {
    expect(resolveAgentOutputFormat(Option.some("text"), true)).toBe("text");
    expect(resolveAgentOutputFormat(Option.some("stream-json"), false)).toBe("stream-json");
    expect(resolveAgentOutputFormat(Option.some("json"), true)).toBe("json");
  });
});
