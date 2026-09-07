/**
 * Unit tests for config.target.ts's `legacyMintConfigTargetErrors` factory and
 * `legacyConfigTargetErrorsFor` builder — independent of any family's own
 * `*.errors.ts` file, so this test keeps verifying the minting mechanism even
 * if diff/pull/push's error files change shape entirely (see
 * `error-actionability-coverage.unit.test.ts`'s runtime/AST-scan split).
 */

import { describe, expect, it } from "vitest";

import { actionability, ErrorActionabilityId } from "../../shared/telemetry/error-actionability.ts";
import { legacyConfigTargetErrorsFor, legacyMintConfigTargetErrors } from "./config.target.ts";

const PREFIX = "LegacyConfigTestMint";

describe("legacyMintConfigTargetErrors", () => {
  const classes = legacyMintConfigTargetErrors(PREFIX);

  it("tags BranchNotFoundError as `${prefix}BranchNotFoundError`", () => {
    expect(new classes.BranchNotFoundError({ message: "x" })._tag).toBe(
      "LegacyConfigTestMintBranchNotFoundError",
    );
  });

  it("tags BranchNotLinkedError as `${prefix}BranchNotLinkedError`", () => {
    expect(new classes.BranchNotLinkedError({ message: "x" })._tag).toBe(
      "LegacyConfigTestMintBranchNotLinkedError",
    );
  });

  it("tags ParentRefInvalidError as `${prefix}ParentRefInvalidError`", () => {
    expect(new classes.ParentRefInvalidError({ message: "x" })._tag).toBe(
      "LegacyConfigTestMintParentRefInvalidError",
    );
  });

  it("tags BranchNotReadyError as `${prefix}BranchNotReadyError`", () => {
    expect(new classes.BranchNotReadyError({ message: "x" })._tag).toBe(
      "LegacyConfigTestMintBranchNotReadyError",
    );
  });

  it("declares BranchNotFoundError as actionability.invalidInput", () => {
    const instance = new classes.BranchNotFoundError({ message: "x" });
    expect(instance[ErrorActionabilityId]).toEqual(actionability.invalidInput);
  });

  it("declares BranchNotLinkedError as actionability.projectNotLinked", () => {
    const instance = new classes.BranchNotLinkedError({ message: "x" });
    expect(instance[ErrorActionabilityId]).toEqual(actionability.projectNotLinked);
  });

  it("declares ParentRefInvalidError as actionability.relinkProject", () => {
    const instance = new classes.ParentRefInvalidError({ message: "x" });
    expect(instance[ErrorActionabilityId]).toEqual(actionability.relinkProject);
  });

  it("declares BranchNotReadyError as actionability.apiStatus with a branch_not_ready fingerprint suffix", () => {
    const instance = new classes.BranchNotReadyError({ message: "x" });
    expect(instance[ErrorActionabilityId]).toEqual({
      ...actionability.apiStatus,
      fingerprint_suffix: "branch_not_ready",
    });
  });

  it("mints genuinely per-call classes, not a cached/shared set, across different prefixes", () => {
    const a = legacyMintConfigTargetErrors("LegacyConfigTestMintA");
    const b = legacyMintConfigTargetErrors("LegacyConfigTestMintB");
    const aTag = new a.BranchNotFoundError({ message: "x" })._tag;
    const bTag = new b.BranchNotFoundError({ message: "x" })._tag;
    expect(aTag).toBe("LegacyConfigTestMintABranchNotFoundError");
    expect(bTag).toBe("LegacyConfigTestMintBBranchNotFoundError");
    expect(aTag).not.toBe(bTag);
  });
});

describe("legacyConfigTargetErrorsFor", () => {
  it("wraps a minted class set into constructors that produce working, correctly tagged instances", () => {
    const classes = legacyMintConfigTargetErrors(PREFIX);
    const errors = legacyConfigTargetErrorsFor({
      notLinked: classes.BranchNotLinkedError,
      parentRefInvalid: classes.ParentRefInvalidError,
      branchNotFound: classes.BranchNotFoundError,
      branchNotReady: classes.BranchNotReadyError,
    });

    const error = errors.branchNotFound("some-target");
    expect(error._tag).toBe("LegacyConfigTestMintBranchNotFoundError");
    expect(error.message).toContain("some-target");
  });
});
