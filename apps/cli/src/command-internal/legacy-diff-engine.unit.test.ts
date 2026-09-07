import { describe, expect, it } from "vitest";

import {
  legacyParseBoolEnv,
  legacyResolveDeclarativeFromArgs,
  legacyResolveDiffEngine,
  legacyResolvePullDiffEngine,
  legacyShouldUsePgDelta,
} from "./legacy-diff-engine.ts";

describe("legacyShouldUsePgDelta", () => {
  it("is the OR of config, flag, and env", () => {
    expect(
      legacyShouldUsePgDelta({ configEnabled: false, usePgDeltaFlag: false, envEnabled: false }),
    ).toBe(false);
    expect(
      legacyShouldUsePgDelta({ configEnabled: true, usePgDeltaFlag: false, envEnabled: false }),
    ).toBe(true);
    expect(
      legacyShouldUsePgDelta({ configEnabled: false, usePgDeltaFlag: true, envEnabled: false }),
    ).toBe(true);
    expect(
      legacyShouldUsePgDelta({ configEnabled: false, usePgDeltaFlag: false, envEnabled: true }),
    ).toBe(true);
  });
});

describe("legacyResolveDiffEngine", () => {
  const base = {
    useMigraChanged: false,
    usePgAdmin: false,
    usePgSchema: false,
    pgDeltaDefault: true,
  };

  it("returns the pg-delta default when no explicit non-delta engine is selected", () => {
    expect(legacyResolveDiffEngine(base)).toBe(true);
    expect(legacyResolveDiffEngine({ ...base, pgDeltaDefault: false })).toBe(false);
  });

  it("an explicit --use-migra clears pg-delta mode", () => {
    expect(legacyResolveDiffEngine({ ...base, useMigraChanged: true })).toBe(false);
  });

  it("--use-pgadmin clears pg-delta mode", () => {
    expect(legacyResolveDiffEngine({ ...base, usePgAdmin: true })).toBe(false);
  });

  it("--use-pg-schema clears pg-delta mode", () => {
    expect(legacyResolveDiffEngine({ ...base, usePgSchema: true })).toBe(false);
  });
});

describe("legacyResolvePullDiffEngine", () => {
  it("an explicit --diff-engine always wins", () => {
    expect(
      legacyResolvePullDiffEngine({
        engineFlagChanged: true,
        engine: "pg-delta",
        pgDeltaDefault: false,
      }),
    ).toBe(true);
    expect(
      legacyResolvePullDiffEngine({
        engineFlagChanged: true,
        engine: "migra",
        pgDeltaDefault: true,
      }),
    ).toBe(false);
  });

  it("falls back to the pg-delta default when the flag is unset", () => {
    expect(
      legacyResolvePullDiffEngine({
        engineFlagChanged: false,
        engine: "migra",
        pgDeltaDefault: true,
      }),
    ).toBe(true);
    expect(
      legacyResolvePullDiffEngine({
        engineFlagChanged: false,
        engine: "migra",
        pgDeltaDefault: false,
      }),
    ).toBe(false);
  });
});

describe("legacyParseBoolEnv", () => {
  it("accepts only strconv.ParseBool truthy strings", () => {
    for (const v of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(legacyParseBoolEnv(v)).toBe(true);
    }
  });

  it("treats every other value (including unset) as false", () => {
    for (const v of ["0", "f", "FALSE", "false", "yes", "on", "2", "", "TrUe"]) {
      expect(legacyParseBoolEnv(v)).toBe(false);
    }
    expect(legacyParseBoolEnv(undefined)).toBe(false);
  });
});

describe("legacyResolveDeclarativeFromArgs", () => {
  it("returns undefined when neither flag is present", () => {
    expect(legacyResolveDeclarativeFromArgs(["db", "pull"])).toBeUndefined();
    expect(legacyResolveDeclarativeFromArgs([])).toBeUndefined();
  });

  it("treats a bare flag as true", () => {
    expect(legacyResolveDeclarativeFromArgs(["db", "pull", "--declarative"])).toBe(true);
    expect(legacyResolveDeclarativeFromArgs(["db", "pull", "--use-pg-delta"])).toBe(true);
  });

  it("parses an =value with strconv.ParseBool semantics", () => {
    expect(legacyResolveDeclarativeFromArgs(["--declarative=false"])).toBe(false);
    expect(legacyResolveDeclarativeFromArgs(["--declarative=true"])).toBe(true);
    expect(legacyResolveDeclarativeFromArgs(["--use-pg-delta=0"])).toBe(false);
    expect(legacyResolveDeclarativeFromArgs(["--use-pg-delta=1"])).toBe(true);
  });

  it("lets the last occurrence win across both flag names (pflag single-variable bind)", () => {
    expect(legacyResolveDeclarativeFromArgs(["--declarative", "--use-pg-delta=false"])).toBe(false);
    expect(legacyResolveDeclarativeFromArgs(["--use-pg-delta", "--declarative=false"])).toBe(false);
    expect(legacyResolveDeclarativeFromArgs(["--declarative=false", "--use-pg-delta"])).toBe(true);
    expect(legacyResolveDeclarativeFromArgs(["--use-pg-delta=false", "--declarative"])).toBe(true);
  });

  it("ignores tokens after the `--` argv terminator", () => {
    expect(legacyResolveDeclarativeFromArgs(["--declarative", "--", "--use-pg-delta=false"])).toBe(
      true,
    );
    expect(legacyResolveDeclarativeFromArgs(["--", "--declarative"])).toBeUndefined();
  });
});
