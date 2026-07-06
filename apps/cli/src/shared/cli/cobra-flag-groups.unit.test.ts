import { describe, expect, test } from "vitest";
import { cobraMutuallyExclusiveErrorMessage, hasExplicitLongFlag } from "./cobra-flag-groups.ts";

const COMMAND_PATH = ["functions", "deploy"] as const;

describe("hasExplicitLongFlag", () => {
  test("finds a bare flag after the command path", () => {
    expect(hasExplicitLongFlag(["functions", "deploy", "--use-api"], COMMAND_PATH, "use-api")).toBe(
      true,
    );
  });

  test("finds a flag with an inline value", () => {
    expect(
      hasExplicitLongFlag(
        ["functions", "deploy", "--use-docker=false"],
        COMMAND_PATH,
        "use-docker",
      ),
    ).toBe(true);
  });

  test("returns false when the flag is absent", () => {
    expect(hasExplicitLongFlag(["functions", "deploy", "hello"], COMMAND_PATH, "use-api")).toBe(
      false,
    );
  });

  test("stops scanning at a -- terminator", () => {
    expect(
      hasExplicitLongFlag(["functions", "deploy", "--", "--use-api"], COMMAND_PATH, "use-api"),
    ).toBe(false);
  });

  test("ignores a flag that appears before the command path", () => {
    expect(hasExplicitLongFlag(["--use-api", "functions", "deploy"], COMMAND_PATH, "use-api")).toBe(
      false,
    );
  });

  test("falls back to a bare scan when the command path is not found", () => {
    expect(hasExplicitLongFlag(["--use-api"], COMMAND_PATH, "use-api")).toBe(true);
    expect(hasExplicitLongFlag(["--use-docker"], COMMAND_PATH, "use-api")).toBe(false);
  });
});

describe("cobraMutuallyExclusiveErrorMessage", () => {
  test("byte-matches cobra's validateExclusiveFlagGroups template", () => {
    expect(
      cobraMutuallyExclusiveErrorMessage(
        ["use-api", "use-docker", "legacy-bundle"],
        ["use-docker", "use-api"],
      ),
    ).toBe(
      "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [use-api use-docker] were all set",
    );
  });

  test("sorts the changed subset alphabetically regardless of input order", () => {
    expect(
      cobraMutuallyExclusiveErrorMessage(
        ["use-api", "use-docker", "legacy-bundle"],
        ["use-api", "legacy-bundle"],
      ),
    ).toBe(
      "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [legacy-bundle use-api] were all set",
    );
  });
});
