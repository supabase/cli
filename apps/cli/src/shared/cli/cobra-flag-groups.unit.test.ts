import { describe, expect, test } from "vitest";
import {
  cobraMutuallyExclusiveErrorMessage,
  hasExplicitLongFlag,
  hasExplicitValueFlag,
} from "./cobra-flag-groups.ts";

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

describe("hasExplicitValueFlag", () => {
  const SSO_UPDATE_PATH = ["sso", "update"] as const;
  const VALUE_FLAGS = new Set(["metadata-file", "metadata-url", "domains", "add-domains"]);

  test("finds a bare flag after the command path", () => {
    expect(
      hasExplicitValueFlag(
        ["sso", "update", "id", "--metadata-file", "foo.xml"],
        SSO_UPDATE_PATH,
        VALUE_FLAGS,
        "metadata-file",
      ),
    ).toBe(true);
  });

  test("finds a flag with an inline value", () => {
    expect(
      hasExplicitValueFlag(
        ["sso", "update", "id", "--domains=a.com"],
        SSO_UPDATE_PATH,
        VALUE_FLAGS,
        "domains",
      ),
    ).toBe(true);
  });

  test("does not mistake a value-taking flag's consumed value for a sibling flag", () => {
    // pflag's `--flag arg` branch consumes the next token unconditionally
    // (`flag.go:1013-1031`), so `--metadata-file --metadata-url` gives
    // `metadata-file` the literal value `"--metadata-url"` and never parses
    // `--metadata-url` as its own flag.
    const args = ["sso", "update", "id", "--metadata-file", "--metadata-url"];
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-file")).toBe(true);
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-url")).toBe(false);
  });

  test("does not mistake a value-taking flag's consumed value for a sibling flag, reversed", () => {
    const args = ["sso", "update", "id", "--metadata-url", "--metadata-file"];
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-url")).toBe(true);
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-file")).toBe(false);
  });

  test("an inline (`=`) value is never treated as consuming the next token", () => {
    // `--metadata-file=--metadata-url` is one token: metadata-file's value is
    // the literal string "--metadata-url", and no token is consumed after it.
    const args = ["sso", "update", "id", "--metadata-file=--metadata-url", "--domains", "a.com"];
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-file")).toBe(true);
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-url")).toBe(false);
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "domains")).toBe(true);
  });

  test("a real, non-adjacent occurrence of both flags is still detected", () => {
    const args = ["sso", "update", "id", "--metadata-file", "foo.xml", "--metadata-url", "url"];
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-file")).toBe(true);
    expect(hasExplicitValueFlag(args, SSO_UPDATE_PATH, VALUE_FLAGS, "metadata-url")).toBe(true);
  });

  test("returns false when the flag is absent", () => {
    expect(
      hasExplicitValueFlag(["sso", "update", "id"], SSO_UPDATE_PATH, VALUE_FLAGS, "domains"),
    ).toBe(false);
  });

  test("stops scanning at a -- terminator", () => {
    expect(
      hasExplicitValueFlag(
        ["sso", "update", "id", "--", "--domains"],
        SSO_UPDATE_PATH,
        VALUE_FLAGS,
        "domains",
      ),
    ).toBe(false);
  });

  test("falls back to a bare scan when the command path is not found", () => {
    expect(hasExplicitValueFlag(["--domains"], SSO_UPDATE_PATH, VALUE_FLAGS, "domains")).toBe(true);
    expect(hasExplicitValueFlag(["--metadata-file"], SSO_UPDATE_PATH, VALUE_FLAGS, "domains")).toBe(
      false,
    );
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
