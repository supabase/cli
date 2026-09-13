import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildFunctionsServeInspectArgs,
  type FunctionsServeFlags,
  resolveFunctionsServeInspectMode,
} from "../../../shared/functions/serve.ts";

function baseFlags(): FunctionsServeFlags {
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

describe("functions serve inspect flags", () => {
  it("treats --inspect-mode brk", () => {
    expect(resolveFunctionsServeInspectMode({ ...baseFlags(), inspect: true })).toBe("brk");
  });

  it("uses the explicit inspect mode when set", () => {
    expect(
      resolveFunctionsServeInspectMode({
        ...baseFlags(),
        inspectMode: Option.some("wait"),
      }),
    ).toBe("wait");
  });

  it("rejects setting both --inspect and --inspect-mode", () => {
    expect(() =>
      resolveFunctionsServeInspectMode({
        ...baseFlags(),
        inspect: true,
        inspectMode: Option.some("run"),
      }),
    ).toThrow(
      "if any flags in the group [inspect inspect-mode] are set none of the others can be; [inspect inspect-mode] were all set",
    );
  });

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
