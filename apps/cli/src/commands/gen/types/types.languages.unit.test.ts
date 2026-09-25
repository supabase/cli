import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { GEN_TYPES_CORE_FLAG_NAMES } from "./types.command.ts";
import {
  GEN_TYPES_LANGUAGE_FLAG_NAMES,
  GEN_TYPES_LANGUAGE_VALUE_FLAG_NAMES,
  GEN_TYPES_LANGUAGES,
  genTypesLanguageFlagDefaults,
  genTypesLanguageFlags,
  languageOptionValues,
} from "./types.languages.ts";

describe("registry-derived gen types flags", () => {
  it("lists every registry language and keeps typescript first", () => {
    expect(GEN_TYPES_LANGUAGES[0]).toBe("typescript");
    expect(GEN_TYPES_LANGUAGES).toEqual(expect.arrayContaining(["go", "python", "swift", "dart"]));
  });

  it("exposes swift-access-control as the only user flag today", () => {
    expect(GEN_TYPES_LANGUAGE_FLAG_NAMES).toEqual(["swift-access-control"]);
    expect(GEN_TYPES_LANGUAGE_VALUE_FLAG_NAMES).toEqual(["swift-access-control"]);
    expect(genTypesLanguageFlagDefaults()).toEqual({
      "supabase-gen-types swift-access-control": "internal",
    });
  });

  it("does not let a registry flag reuse a core flag name", () => {
    expect(() => genTypesLanguageFlags(GEN_TYPES_CORE_FLAG_NAMES)).not.toThrow();
    expect(() => genTypesLanguageFlags(["swift-access-control"])).toThrow(
      /collide with gen types flags: swift-access-control/,
    );
  });

  it("reads parsed language flags back into registry option values", () => {
    expect(languageOptionValues({ "swift-access-control": "public", lang: "swift" })).toEqual({
      "swift-access-control": "public",
    });
    expect(languageOptionValues({ "swift-access-control": Option.some("package") })).toEqual({
      "swift-access-control": "package",
    });
    expect(languageOptionValues({ "swift-access-control": Option.none() })).toEqual({});
    expect(languageOptionValues({})).toEqual({});
  });
});
