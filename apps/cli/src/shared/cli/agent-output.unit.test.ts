import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { resolveAgentOutputFormat, resolveAgentOutputFormatFromArgs } from "./agent-output.ts";

describe("resolveAgentOutputFormat", () => {
  it("defaults a coding agent to json", () => {
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.none(),
        detectedAgentName: Option.some("codex"),
      }),
    ).toBe("json");
  });

  it("defaults a non-agent to text", () => {
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.none(),
        detectedAgentName: Option.none(),
      }),
    ).toBe("text");
  });

  it("honors an explicit format over agent detection", () => {
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.some("text"),
        detectedAgentName: Option.some("codex"),
      }),
    ).toBe("text");
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.some("stream-json"),
        detectedAgentName: Option.none(),
      }),
    ).toBe("stream-json");
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.some("json"),
        detectedAgentName: Option.some("codex"),
      }),
    ).toBe("json");
  });

  it("keeps legacy --output authoritative over the agent JSON default", () => {
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.none(),
        legacyOutputFormat: Option.some("pretty"),
        detectedAgentName: Option.some("codex"),
      }),
    ).toBe("text");
  });

  it("honors the legacy --agent override", () => {
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.none(),
        agentOverride: "no",
        detectedAgentName: Option.some("codex"),
      }),
    ).toBe("text");
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.none(),
        agentOverride: "yes",
        detectedAgentName: Option.none(),
      }),
    ).toBe("json");
  });

  it("keeps built-in help and version text unless output-format is explicit", () => {
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.none(),
        detectedAgentName: Option.some("codex"),
        isBuiltInTextRequest: true,
      }),
    ).toBe("text");
    expect(
      resolveAgentOutputFormat({
        explicitOutputFormat: Option.some("json"),
        detectedAgentName: Option.some("codex"),
        isBuiltInTextRequest: true,
      }),
    ).toBe("json");
  });

  it("resolves the effective format from raw argv for runtime error formatting", () => {
    expect(resolveAgentOutputFormatFromArgs(["bad-command"], Option.some("codex"))).toBe("json");
    expect(
      resolveAgentOutputFormatFromArgs(
        ["--output-format", "text", "bad-command"],
        Option.some("codex"),
      ),
    ).toBe("text");
    expect(
      resolveAgentOutputFormatFromArgs(["-o", "pretty", "bad-command"], Option.some("codex")),
    ).toBe("text");
    expect(
      resolveAgentOutputFormatFromArgs(
        ["--output-format=stream-json", "bad-command"],
        Option.some("codex"),
      ),
    ).toBe("stream-json");
    expect(
      resolveAgentOutputFormatFromArgs(["--agent", "no", "bad-command"], Option.some("codex")),
    ).toBe("text");
    expect(resolveAgentOutputFormatFromArgs(["--agent=yes", "bad-command"], Option.none())).toBe(
      "json",
    );
    expect(resolveAgentOutputFormatFromArgs(["--version"], Option.some("codex"))).toBe("text");
    expect(
      resolveAgentOutputFormatFromArgs(
        ["--profile", "supabase", "--version"],
        Option.some("codex"),
      ),
    ).toBe("text");
    expect(resolveAgentOutputFormatFromArgs(["--help"], Option.some("codex"))).toBe("text");
    expect(
      resolveAgentOutputFormatFromArgs(["db", "reset", "--version", "1"], Option.some("codex")),
    ).toBe("json");
    expect(
      resolveAgentOutputFormatFromArgs(["--output-format=json", "--help"], Option.some("codex")),
    ).toBe("json");
  });
});
