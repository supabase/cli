import { describe, expect, test } from "vitest";
import { cobraMutuallyExclusiveErrorMessage, hasExplicitLongFlag } from "./cobra-flag-groups.ts";

const COMMAND_PATH = ["functions", "deploy"] as const;
const NO_VALUE_CONSUMING_FLAGS: ReadonlySet<string> = new Set();
const PROJECT_REF_VALUE_CONSUMING_FLAGS = new Set(["project-ref"]);

describe("hasExplicitLongFlag", () => {
  test("finds a bare flag after the command path", () => {
    expect(
      hasExplicitLongFlag(
        ["functions", "deploy", "--use-api"],
        COMMAND_PATH,
        "use-api",
        NO_VALUE_CONSUMING_FLAGS,
      ),
    ).toBe(true);
  });

  test("finds a flag with an inline value", () => {
    expect(
      hasExplicitLongFlag(
        ["functions", "deploy", "--use-docker=false"],
        COMMAND_PATH,
        "use-docker",
        NO_VALUE_CONSUMING_FLAGS,
      ),
    ).toBe(true);
  });

  test("returns false when the flag is absent", () => {
    expect(
      hasExplicitLongFlag(
        ["functions", "deploy", "hello"],
        COMMAND_PATH,
        "use-api",
        NO_VALUE_CONSUMING_FLAGS,
      ),
    ).toBe(false);
  });

  test("stops scanning at a -- terminator", () => {
    expect(
      hasExplicitLongFlag(
        ["functions", "deploy", "--", "--use-api"],
        COMMAND_PATH,
        "use-api",
        NO_VALUE_CONSUMING_FLAGS,
      ),
    ).toBe(false);
  });

  test("ignores a flag that appears before the command path", () => {
    expect(
      hasExplicitLongFlag(
        ["--use-api", "functions", "deploy"],
        COMMAND_PATH,
        "use-api",
        NO_VALUE_CONSUMING_FLAGS,
      ),
    ).toBe(false);
  });

  test("falls back to a bare scan when the command path is not found", () => {
    expect(
      hasExplicitLongFlag(["--use-api"], COMMAND_PATH, "use-api", NO_VALUE_CONSUMING_FLAGS),
    ).toBe(true);
    expect(
      hasExplicitLongFlag(["--use-docker"], COMMAND_PATH, "use-api", NO_VALUE_CONSUMING_FLAGS),
    ).toBe(false);
  });

  // Regression coverage for a real Cobra/pflag divergence: a bare
  // space-separated string flag (e.g. `--project-ref`) consumes the very
  // next raw-argv token as its own value, even when that token looks like
  // another flag. Without skipping it, the scan would wrongly report the
  // consumed token's flag as "changed" too.
  test("skips the value token consumed by a preceding value-consuming flag", () => {
    const rawArgs = ["functions", "deploy", "--project-ref", "--use-api", "--legacy-bundle"];
    expect(
      hasExplicitLongFlag(rawArgs, COMMAND_PATH, "use-api", PROJECT_REF_VALUE_CONSUMING_FLAGS),
    ).toBe(false);
    expect(
      hasExplicitLongFlag(
        rawArgs,
        COMMAND_PATH,
        "legacy-bundle",
        PROJECT_REF_VALUE_CONSUMING_FLAGS,
      ),
    ).toBe(true);
  });

  test("does not skip a value when the value-consuming flag uses the inline = form", () => {
    const rawArgs = ["functions", "deploy", "--project-ref=my-ref", "--use-api"];
    expect(
      hasExplicitLongFlag(rawArgs, COMMAND_PATH, "use-api", PROJECT_REF_VALUE_CONSUMING_FLAGS),
    ).toBe(true);
  });

  test("skips the consumed value token in the fallback scan too", () => {
    const rawArgs = ["--project-ref", "--use-api"];
    expect(
      hasExplicitLongFlag(rawArgs, COMMAND_PATH, "use-api", PROJECT_REF_VALUE_CONSUMING_FLAGS),
    ).toBe(false);
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
