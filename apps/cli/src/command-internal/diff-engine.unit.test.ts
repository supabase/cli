import { describe, expect, it } from "vitest";

import {
  parseBoolEnv,
  resolveDeclarativeFromArgs,
  resolveDiffEngine,
  resolvePullDiffEngine,
  shouldUsePgDelta,
} from "./diff-engine.ts";

describe("shouldUsePgDelta", () => {
  it("follows the config default and lets --use-pg-delta override an explicit rollback", () => {
    expect(shouldUsePgDelta({ configEnabled: false, usePgDeltaFlag: false })).toBe(false);
    expect(shouldUsePgDelta({ configEnabled: true, usePgDeltaFlag: false })).toBe(true);
    expect(shouldUsePgDelta({ configEnabled: false, usePgDeltaFlag: true })).toBe(true);
  });
});

describe("resolveDiffEngine", () => {
  const base = {
    useMigraChanged: false,
    usePgAdmin: false,
    usePgSchema: false,
    pgDeltaDefault: true,
  };

  it("returns the pg-delta default when no explicit non-delta engine is selected", () => {
    expect(resolveDiffEngine(base)).toBe(true);
    expect(resolveDiffEngine({ ...base, pgDeltaDefault: false })).toBe(false);
  });

  it("an explicit --use-migra clears pg-delta mode", () => {
    expect(resolveDiffEngine({ ...base, useMigraChanged: true })).toBe(false);
  });

  it("--use-pgadmin clears pg-delta mode", () => {
    expect(resolveDiffEngine({ ...base, usePgAdmin: true })).toBe(false);
  });

  it("--use-pg-schema clears pg-delta mode", () => {
    expect(resolveDiffEngine({ ...base, usePgSchema: true })).toBe(false);
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

describe("parseBoolEnv", () => {
  it("accepts only strconv.ParseBool truthy strings", () => {
    for (const v of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(parseBoolEnv(v)).toBe(true);
    }
  });

  it("treats every other value (including unset) as false", () => {
    for (const v of ["0", "f", "FALSE", "false", "yes", "on", "2", "", "TrUe"]) {
      expect(parseBoolEnv(v)).toBe(false);
    }
    expect(parseBoolEnv(undefined)).toBe(false);
  });
});

describe("resolveDeclarativeFromArgs", () => {
  it("returns undefined when neither flag is present", () => {
    expect(resolveDeclarativeFromArgs(["db", "pull"])).toBeUndefined();
    expect(resolveDeclarativeFromArgs([])).toBeUndefined();
  });

  it("treats a bare flag as true", () => {
    expect(resolveDeclarativeFromArgs(["db", "pull", "--declarative"])).toBe(true);
    expect(resolveDeclarativeFromArgs(["db", "pull", "--use-pg-delta"])).toBe(true);
  });

  it("parses an =value with strconv.ParseBool semantics", () => {
    expect(resolveDeclarativeFromArgs(["--declarative=false"])).toBe(false);
    expect(resolveDeclarativeFromArgs(["--declarative=true"])).toBe(true);
    expect(resolveDeclarativeFromArgs(["--use-pg-delta=0"])).toBe(false);
    expect(resolveDeclarativeFromArgs(["--use-pg-delta=1"])).toBe(true);
  });

  it("lets the last occurrence win across both flag names (pflag single-variable bind)", () => {
    expect(resolveDeclarativeFromArgs(["--declarative", "--use-pg-delta=false"])).toBe(false);
    expect(resolveDeclarativeFromArgs(["--use-pg-delta", "--declarative=false"])).toBe(false);
    expect(resolveDeclarativeFromArgs(["--declarative=false", "--use-pg-delta"])).toBe(true);
    expect(resolveDeclarativeFromArgs(["--use-pg-delta=false", "--declarative"])).toBe(true);
  });

  it("ignores tokens after the `--` argv terminator", () => {
    expect(resolveDeclarativeFromArgs(["--declarative", "--", "--use-pg-delta=false"])).toBe(true);
    expect(resolveDeclarativeFromArgs(["--", "--declarative"])).toBeUndefined();
  });
});
