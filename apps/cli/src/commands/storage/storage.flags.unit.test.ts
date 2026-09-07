import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  legacyAssertStorageTargetsExclusive,
  legacyStorageChangedTargetFlags,
} from "./storage.flags.ts";

describe("legacyStorageChangedTargetFlags", () => {
  it("detects neither when no target flag is present", () => {
    expect(legacyStorageChangedTargetFlags(["storage", "ls", "ss:///"])).toEqual([]);
  });

  it("detects --linked and --local in cobra's sorted order", () => {
    expect(legacyStorageChangedTargetFlags(["storage", "--local", "--linked", "ls"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("treats the negation form as changed", () => {
    expect(legacyStorageChangedTargetFlags(["storage", "ls", "--no-local"])).toEqual(["local"]);
  });

  it("does not mistake a value token for a target flag", () => {
    // `--workdir --linked`: `--linked` is the value of `--workdir`, not a selector.
    expect(legacyStorageChangedTargetFlags(["storage", "--workdir", "--linked", "ls"])).toEqual([]);
  });

  it("skips the value of `storage cp` value-consuming flags (content-type/cache-control/jobs)", () => {
    // The value following a bare `--content-type`/`--cache-control`/`--jobs`/`-j`
    // is consumed as that flag's argument, so a `--local`/`--linked` token there
    // must NOT be detected as a selector.
    expect(
      legacyStorageChangedTargetFlags(["storage", "cp", "--content-type", "--local", "a", "b"]),
    ).toEqual([]);
    expect(
      legacyStorageChangedTargetFlags(["storage", "cp", "--cache-control", "--linked", "a", "b"]),
    ).toEqual([]);
    expect(
      legacyStorageChangedTargetFlags(["storage", "cp", "--jobs", "--local", "a", "b"]),
    ).toEqual([]);
    expect(legacyStorageChangedTargetFlags(["storage", "cp", "-j", "--linked", "a", "b"])).toEqual(
      [],
    );
  });

  it("still detects a real selector after a `storage cp` flag's value", () => {
    // `--jobs 5` consumes `5`; the trailing `--local` is a genuine selector.
    expect(
      legacyStorageChangedTargetFlags(["storage", "cp", "--jobs", "5", "--local", "a", "b"]),
    ).toEqual(["local"]);
  });

  it("ignores tokens after the -- sentinel", () => {
    expect(legacyStorageChangedTargetFlags(["storage", "ls", "--", "--local"])).toEqual([]);
  });

  it("detects flags given after the subcommand token (persistent globals)", () => {
    expect(legacyStorageChangedTargetFlags(["storage", "rm", "ss:///b/x", "--local"])).toEqual([
      "local",
    ]);
  });
});

describe("legacyAssertStorageTargetsExclusive", () => {
  it("rejects passing both --linked and --local (byte-exact cobra message)", () =>
    Effect.gen(function* () {
      const exit = yield* legacyAssertStorageTargetsExclusive([
        "storage",
        "--linked",
        "--local",
        "ls",
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "if any flags in the group [linked local] are set none of the others can be; [linked local] were all set",
      );
    }));

  it("accepts only --local", () =>
    Effect.gen(function* () {
      const exit = yield* legacyAssertStorageTargetsExclusive(["storage", "--local", "ls"]).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }));

  it("accepts neither flag", () =>
    Effect.gen(function* () {
      const exit = yield* legacyAssertStorageTargetsExclusive(["storage", "ls"]).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }));
});
