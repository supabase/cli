import { describe, expect, it } from "@effect/vitest";
import {
  findLanguage,
  InvalidOptionError,
  ToolFailedError,
  ToolNotInstalledError,
} from "@supabase/typegen";
import { declaredOptions, mapRegistryError } from "./types.generator.layer.ts";
import {
  GenTypesGenerationError,
  GenTypesToolFailedError,
  GenTypesToolNotInstalledError,
} from "./types.generator.service.ts";

describe("registry error mapping", () => {
  it("keeps the registry's message, install hint included, for a missing toolchain", () => {
    const hint = "Install the Dart SDK.";
    const mapped = mapRegistryError(
      "dart",
      new ToolNotInstalledError({
        language: "dart",
        tool: "dart",
        installHint: hint,
        message: `Generating dart types needs \`dart\`, which was not found on PATH. ${hint}`,
      }),
    );
    expect(mapped).toBeInstanceOf(GenTypesToolNotInstalledError);
    expect(mapped.message).toBe(
      `Generating dart types needs \`dart\`, which was not found on PATH. ${hint}`,
    );
  });

  it("keeps the tool's stderr when it fails", () => {
    const mapped = mapRegistryError(
      "dart",
      new ToolFailedError({
        language: "dart",
        command: ["dart", "run"],
        exitCode: 78,
        stderr: "needs Dart 3.8",
        message: "`dart run` exited with code 78.\nneeds Dart 3.8",
      }),
    );
    expect(mapped).toBeInstanceOf(GenTypesToolFailedError);
    expect(mapped.message).toContain("needs Dart 3.8");
  });

  it("reports a rejected option and any other failure as a generation error", () => {
    const invalid = mapRegistryError(
      "swift",
      new InvalidOptionError({ language: "swift", option: "x", message: "no option x" }),
    );
    expect(invalid).toBeInstanceOf(GenTypesGenerationError);
    expect(invalid.message).toBe("no option x");
    const other = mapRegistryError("go", new Error("boom"));
    expect(other).toBeInstanceOf(GenTypesGenerationError);
    expect(other.message).toBe("failed to generate go types: boom");
  });
});

describe("declaredOptions", () => {
  it("forwards only the options the language declares", () => {
    const swift = findLanguage("swift")!;
    expect(
      declaredOptions(swift, {
        "swift-access-control": "public",
        "detect-one-to-one-relationships": false,
        unknown: true,
      }),
    ).toEqual({ "swift-access-control": "public" });
    expect(
      declaredOptions(findLanguage("typescript")!, {
        "swift-access-control": "public",
        "detect-one-to-one-relationships": false,
      }),
    ).toEqual({ "detect-one-to-one-relationships": false });
    expect(declaredOptions(findLanguage("go")!, { "swift-access-control": "public" })).toEqual({});
  });
});
