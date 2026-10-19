import { describe, expect, it } from "vitest";

import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";
import {
  TargetEmptyValueError,
  TargetNeedsProjectError,
  TargetPasswordConflictError,
  TargetProjectRefConflictError,
  TargetRemoteAmbiguousError,
  TargetSelectorConflictError,
} from "./target.errors.ts";

describe("target errors", () => {
  it.each([
    new TargetSelectorConflictError({ flags: ["--local", "--linked"], message: "m" }),
    new TargetProjectRefConflictError({ conflictsWith: "--local", message: "m" }),
    new TargetEmptyValueError({ flag: "--db-url", message: "m", suggestion: "s" }),
    new TargetNeedsProjectError({ message: "m" }),
    new TargetRemoteAmbiguousError({ message: "m" }),
    new TargetPasswordConflictError({ target: "local", message: "m" }),
  ])("classifies $_tag as invalid input the user can fix", (error) => {
    expect(classifyCliErrorActionability(error)).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
    });
  });
});
