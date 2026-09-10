import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { assertStorageTargetsExclusive, storageChangedTargetFlags } from "./storage.flags.ts";

describe("storageChangedTargetFlags", () => {
  it("detects neither when no target flag is present", () => {
    expect(storageChangedTargetFlags(["storage", "ls", "ss:///"])).toEqual([]);
  });

  it("detects --linked and --local in cobra's sorted order", () => {
    expect(storageChangedTargetFlags(["storage", "--local", "--linked", "ls"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("treats the negation form as changed", () => {
    expect(storageChangedTargetFlags(["storage", "ls", "--no-local"])).toEqual(["local"]);
  });

  it("does not mistake a value token for a target flag", () => {
    // `--workdir --linked`: `--linked` is the value of `--workdir`, not a selector.
    expect(storageChangedTargetFlags(["storage", "--workdir", "--linked", "ls"])).toEqual([]);
  });

  it("skips the value of `storage cp` value-consuming flags (content-type/cache-control/jobs)", () => {
    expect(
      storageChangedTargetFlags(["storage", "cp", "--content-type", "--local", "a", "b"]),
    ).toEqual([]);
    expect(
      storageChangedTargetFlags(["storage", "cp", "--cache-control", "--linked", "a", "b"]),
    ).toEqual([]);
    expect(storageChangedTargetFlags(["storage", "cp", "--jobs", "--local", "a", "b"])).toEqual([]);
    expect(storageChangedTargetFlags(["storage", "cp", "-j", "--linked", "a", "b"])).toEqual([]);
  });

  it("still detects a real selector after a `storage cp` flag's value", () => {
    // `--jobs 5` consumes `5`; the trailing `--local` is a genuine selector.
    expect(
      storageChangedTargetFlags(["storage", "cp", "--jobs", "5", "--local", "a", "b"]),
    ).toEqual(["local"]);
  });

  it("ignores tokens after the -- sentinel", () => {
    expect(storageChangedTargetFlags(["storage", "ls", "--", "--local"])).toEqual([]);
  });

  it("detects flags given after the subcommand token (persistent globals)", () => {
    expect(storageChangedTargetFlags(["storage", "rm", "ss:///b/x", "--local"])).toEqual(["local"]);
  });
});

describe("assertStorageTargetsExclusive", () => {
  it("rejects passing both --linked and --local (byte-exact cobra message)", () =>
    Effect.gen(function* () {
      const exit = yield* assertStorageTargetsExclusive([
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
      const exit = yield* assertStorageTargetsExclusive(["storage", "--local", "ls"]).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }));

  it("accepts neither flag", () =>
    Effect.gen(function* () {
      const exit = yield* assertStorageTargetsExclusive(["storage", "ls"]).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }));
});
