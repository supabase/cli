import { describe, expect, it } from "@effect/vitest";
import type { OptionSpec } from "@supabase/typegen";
import { Option } from "effect";
import { languageFlagsFor, mergeUserOptions, optionValuesFor } from "./types.languages.ts";
import { docsFlagDoc } from "../../../docs/docs-spec.ts";

const level = (choices: ReadonlyArray<string>, fallback: string): OptionSpec => ({
  name: "level",
  audience: "user",
  kind: "choice",
  choices,
  default: fallback,
  help: "Access level.",
});

describe("mergeUserOptions", () => {
  it("skips consumer options and keeps one flag per name", () => {
    const merged = mergeUserOptions([
      level(["a", "b"], "a"),
      { name: "version", audience: "consumer", kind: "string", help: "" },
      level(["b", "c"], "a"),
    ]);
    expect(merged).toEqual([
      {
        name: "level",
        kind: "choice",
        help: "Access level.",
        choices: ["a", "b", "c"],
        default: "a",
      },
    ]);
  });

  it("drops the default when the declaring languages disagree", () => {
    const [merged] = mergeUserOptions([level(["a", "b"], "a"), level(["a", "b"], "b")]);
    expect(merged?.default).toBeUndefined();
  });

  it("refuses one name declared with two kinds", () => {
    expect(() =>
      mergeUserOptions([
        level(["a"], "a"),
        { name: "level", audience: "user", kind: "boolean", default: false, help: "" },
      ]),
    ).toThrow(/--level as both choice and boolean/);
  });
});

describe("languageFlagsFor", () => {
  const specs = mergeUserOptions([level(["a", "b"], "a")]);

  it("refuses a registry flag that reuses a reserved name", () => {
    expect(() => languageFlagsFor(specs, ["lang", "level"])).toThrow(
      /collide with CLI flags: level/,
    );
    expect(Object.keys(languageFlagsFor(specs, ["lang"]))).toEqual(["level"]);
  });
});

describe("optionValuesFor", () => {
  const specs = mergeUserOptions([
    level(["a", "b"], "a"),
    { name: "verbose", audience: "user", kind: "boolean", default: false, help: "" },
  ]);

  it("forwards only the flags the user set, so each language applies its own default", () => {
    expect(optionValuesFor(specs, { level: Option.some("b"), verbose: Option.none() })).toEqual({
      level: "b",
    });
    expect(optionValuesFor(specs, { level: Option.none(), verbose: Option.some(true) })).toEqual({
      verbose: true,
    });
    expect(optionValuesFor(specs, { lang: "swift" })).toEqual({});
  });
});

describe("language flag documentation", () => {
  it("documents a default only when it is unambiguous", () => {
    const documented = (specs: ReadonlyArray<OptionSpec>) =>
      Object.values(languageFlagsFor(mergeUserOptions(specs), [])).map(
        (flag) => docsFlagDoc(["supabase", "gen", "types"], flag)?.default_value,
      );
    expect(documented([level(["a"], "a")])).toEqual(["a"]);
    expect(documented([level(["a"], "a"), level(["b"], "b")])).toEqual([""]);
  });
});
