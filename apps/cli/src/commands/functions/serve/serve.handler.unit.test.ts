import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  legacyBuildFunctionsServeInspectArgs,
  legacyResolveFunctionsServeInspectMode,
  type LegacyFunctionsServeFlags,
} from "./serve.handler.ts";

function baseFlags(): LegacyFunctionsServeFlags {
  return {
    noVerifyJwt: Option.none(),
    envFile: Option.none(),
    importMap: Option.none(),
    inspect: false,
    inspectMode: Option.none(),
    inspectMain: false,
    all: true,
  };
}

describe("legacy functions serve inspect flags", () => {
  it("treats --inspect as inspect-mode brk", () => {
    expect(legacyResolveFunctionsServeInspectMode({ ...baseFlags(), inspect: true })).toBe("brk");
  });

  it("uses the explicit inspect mode when set", () => {
    expect(
      legacyResolveFunctionsServeInspectMode({
        ...baseFlags(),
        inspectMode: Option.some("wait"),
      }),
    ).toBe("wait");
  });

  it("rejects setting both --inspect and --inspect-mode", () => {
    expect(() =>
      legacyResolveFunctionsServeInspectMode({
        ...baseFlags(),
        inspect: true,
        inspectMode: Option.some("run"),
      }),
    ).toThrow(
      "if any flags in the group [inspect inspect-mode] are set none of the others can be; [inspect inspect-mode] were all set",
    );
  });

  it("rejects --inspect-main without an inspect mode", () => {
    expect(() => legacyBuildFunctionsServeInspectArgs(undefined, true)).toThrow(
      "--inspect-main must be used together with one of these flags: [inspect inspect-mode]",
    );
  });

  it("builds the edge-runtime inspect flags for explicit modes", () => {
    expect(legacyBuildFunctionsServeInspectArgs("wait", true)).toEqual([
      "--inspect-wait=0.0.0.0:8083",
      "--inspect-main",
    ]);
    expect(legacyBuildFunctionsServeInspectArgs("run", false)).toEqual(["--inspect=0.0.0.0:8083"]);
  });
});
