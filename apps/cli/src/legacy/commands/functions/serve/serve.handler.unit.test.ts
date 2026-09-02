import { describe, expect, it } from "vitest";
import { buildFunctionsServeInspectArgs } from "../../../../shared/functions/serve.ts";

describe("legacy functions serve inspect flags", () => {
  it("rejects --inspect-main without an inspect mode", () => {
    expect(() => buildFunctionsServeInspectArgs(undefined, true)).toThrow(
      "--inspect-main must be used together with one of these flags: [inspect inspect-mode]",
    );
  });

  it("builds the edge-runtime inspect flags for explicit modes", () => {
    expect(buildFunctionsServeInspectArgs("wait", true)).toEqual([
      "--inspect-wait=0.0.0.0:8083",
      "--inspect-main",
    ]);
    expect(buildFunctionsServeInspectArgs("run", false)).toEqual(["--inspect=0.0.0.0:8083"]);
  });
});
