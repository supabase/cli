import { describe, expect, it } from "vitest";

import { resolveDiffEngine, resolvePullDiffEngine } from "./diff-engine.ts";

describe("resolveDiffEngine", () => {
  const base = {
    useMigra: false,
    usePgAdmin: false,
    pgDeltaDefault: true,
  };

  it("returns the pg-delta default when no explicit non-delta engine is selected", () => {
    expect(resolveDiffEngine(base)).toBe(true);
    expect(resolveDiffEngine({ ...base, pgDeltaDefault: false })).toBe(false);
  });

  it("an explicit --use-migra clears pg-delta mode", () => {
    expect(resolveDiffEngine({ ...base, useMigra: true })).toBe(false);
  });

  it("--use-pgadmin clears pg-delta mode", () => {
    expect(resolveDiffEngine({ ...base, usePgAdmin: true })).toBe(false);
  });
});

describe("resolvePullDiffEngine", () => {
  it("an explicit --diff-engine always wins", () => {
    expect(
      resolvePullDiffEngine({
        engineFlagChanged: true,
        engine: "pg-delta",
        pgDeltaDefault: false,
      }),
    ).toBe(true);
    expect(
      resolvePullDiffEngine({
        engineFlagChanged: true,
        engine: "migra",
        pgDeltaDefault: true,
      }),
    ).toBe(false);
  });

  it("falls back to the pg-delta default when the flag is unset", () => {
    expect(
      resolvePullDiffEngine({
        engineFlagChanged: false,
        engine: "migra",
        pgDeltaDefault: true,
      }),
    ).toBe(true);
    expect(
      resolvePullDiffEngine({
        engineFlagChanged: false,
        engine: "migra",
        pgDeltaDefault: false,
      }),
    ).toBe(false);
  });
});
